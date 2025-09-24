import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CURATED = path.join(DATA, "curated");
const DIGEST_ROOT = path.join(DATA, "digest");
const PROJECTS_ROOT = path.join(ROOT, "projects");
const CACHE = path.join(DATA, "cache");
const STATS_FILE = path.join(CACHE, "digest-stats.json");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

function log(m,c={}){ console.log(`[${new Date().toISOString()}] ${m}`, Object.keys(c).length?c:""); }
async function ensureDir(p){ await fs.mkdir(p,{recursive:true}); }
async function loadJson(p, fb){ try{ return JSON.parse(await fs.readFile(p,"utf8")); } catch { return fb; } }
async function saveJson(p, v){ await ensureDir(path.dirname(p)); await fs.writeFile(p, JSON.stringify(v,null,2), "utf8"); }
async function loadText(p){ try { return await fs.readFile(p,"utf8"); } catch { return ""; } }

async function latestCuratedRun() {
  const days = await fs.readdir(CURATED).catch(()=>[]);
  days.sort().reverse();
  for (const d of days) {
    const dPath = path.join(CURATED, d);
    const stamps = await fs.readdir(dPath).catch(()=>[]);
    stamps.sort().reverse();
    for (const s of stamps) {
      const f = path.join(dPath, s, "items.json");
      const json = await loadJson(f, null);
      if (json) return { dayDir: d, stampDir: s, path: f, content: json };
    }
  }
  return null;
}

async function loadProjects() {
  const dirs = await fs.readdir(PROJECTS_ROOT).catch(()=>[]);
  const projects = [];
  for (const dir of dirs) {
    const cfg = await loadJson(path.join(PROJECTS_ROOT, dir, "project.json"), null);
    if (!cfg) continue;
    const changelog = (await loadText(path.join(PROJECTS_ROOT, dir, "changelog.md")))
      .split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith("#"));
    projects.push({ key: dir, changelog, ...cfg });
  }
  return projects;
}

function collectForProject(items, project) {
  const high = [], moderate = [];
  for (const item of items ?? []) {
    const a = (item.projects ?? []).find(x => x.projectKey === project.key || x.project === project.name);
    if (!a) continue;
    const published = item.publishedAt
      ? new Date(item.publishedAt).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" })
      : null;
    const entry = {
      title: item.title ?? "(untitled)",
      url: item.url ?? null,
      summary: item.summary ?? item.description ?? "",
      usefulness: a.usefulness,
      reason: a.reason ?? "",
      nextSteps: a.nextSteps ?? "",
      publishedAt: published,
      sourceType: item.sourceType ?? "unknown"
    };
    if (a.usefulness === "HIGH") high.push(entry);
    else if (a.usefulness === "MODERATE") moderate.push(entry);
  }
  return { high, moderate };
}

function renderText(payload) {
  const lines = [];
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  lines.push("Daily Digest");
  lines.push(dateStr);
  lines.push(`News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`);
  lines.push("");
  for (const p of payload.projects) {
    lines.push(p.name);
    if (p.summary) lines.push(p.summary);
    lines.push("");
    if (p.high.length) {
      lines.push("Highly Useful");
      for (const e of p.high) {
        lines.push(`- ${e.title}`);
        if (e.summary) lines.push(`  ${e.summary}`);
        if (e.reason) lines.push(`  Why it matters: ${e.reason}`);
        if (e.nextSteps) lines.push(`  Next steps: ${e.nextSteps}`);
        if (e.publishedAt) lines.push(`  Published: ${e.publishedAt}`);
        if (e.url) lines.push(`  Go to source: ${e.url}`);
      }
      lines.push("");
    }
    if (p.moderate.length) {
      lines.push("Moderately Useful");
      for (const e of p.moderate) {
        lines.push(`- ${e.title}`);
        if (e.summary) lines.push(`  ${e.summary}`);
        if (e.reason) lines.push(`  Why it matters: ${e.reason}`);
        if (e.nextSteps) lines.push(`  Next steps: ${e.nextSteps}`);
        if (e.publishedAt) lines.push(`  Published: ${e.publishedAt}`);
        if (e.url) lines.push(`  Go to source: ${e.url}`);
      }
      lines.push("");
    }
    if (p.changelog?.length) {
      lines.push("Recent Changelog Notes");
      for (const note of p.changelog.slice(0,5)) lines.push(`- ${note}`);
      lines.push("");
    }
  }
  lines.push("You can still browse all updates:");
  lines.push("View this digest: https://vibestribe.github.io/kb-site/");
  return lines.join("\n");
}

function renderHtml(payload) {
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  return `<!DOCTYPE html><html><body>
  <h1>Daily Digest</h1>
  <p>${dateStr}</p>
  <p>${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful</p>
  ${payload.projects.map(p=>`
    <h2>${p.name}</h2>
    ${p.summary?`<p>${p.summary}</p>`:""}
    ${p.high.map(e=>`<div><strong>HIGH:</strong> ${e.title}</div>`).join("")}
    ${p.moderate.map(e=>`<div><strong>MODERATE:</strong> ${e.title}</div>`).join("")}
  `).join("")}
  <p><a href="https://vibestribe.github.io/kb-site/">View this digest online</a></p>
  </body></html>`;
}

async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  if (!BREVO_API_KEY) { log("BREVO_API_KEY missing; skip email"); return; }
  if (!recipients?.length) { log("BREVO_TO not configured; skip email"); return; }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
      to: recipients.map(e=>({ email: e })),
      subject,
      textContent,
      htmlContent
    })
  });
  if (!res.ok) throw new Error(`Brevo ${res.status} ${await res.text()}`);
  log("Digest email sent", { recipients: recipients.length });
}

export async function digest() {
  const run = await latestCuratedRun();
  if (!run) { log("No curated data found; skip digest"); await saveJson(STATS_FILE, { count: 0 }); return; }

  const allProjects = await loadProjects();
  const active = allProjects.filter(p => (p.status||"active")==="active");

  const digestDir = path.join(DIGEST_ROOT, run.dayDir, run.stampDir);
  await ensureDir(digestDir);
  const jsonPath = path.join(digestDir, "digest.json");
  const txtPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  const payload = (await loadJson(jsonPath, null)) || {
    generatedAt: new Date().toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: []
  };

  for (const proj of active) {
    if (payload.projects.some(p => p.key === proj.key)) continue;
    const { high, moderate } = collectForProject(run.content.items, proj);
    if (!high.length && !moderate.length) continue;

    payload.projects.push({
      key: proj.key, name: proj.name, summary: proj.summary,
      high, moderate, changelog: proj.changelog ?? []
    });
    payload.totalHigh += high.length;
    payload.totalModerate += moderate.length;
    payload.subject = `Daily Digest – ${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`;

    await saveJson(jsonPath, payload);
    await fs.writeFile(txtPath, renderText(payload), "utf8");
    await fs.writeFile(htmlPath, renderHtml(payload), "utf8");
    log("Digest checkpoint saved", { project: proj.name });
  }

  await saveJson(CACHE + "/last-digest.json", payload);
  await saveJson(STATS_FILE, { count: payload.projects.length });

  if (payload.projects.length) {
    const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
    try {
      await sendBrevoEmail({
        subject: payload.subject,
        textContent: await fs.readFile(txtPath, "utf8"),
        htmlContent: await fs.readFile(htmlPath, "utf8"),
        recipients
      });
    } catch (e) {
      log("Brevo send failed", { error: e.message });
    }
  } else {
    log("Digest contains no actionable items; skipping email send");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((e)=>{ console.error("Digest failed", e); process.exitCode=1; });
}


/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch(err => { console.error("Digest step failed", err); process.exitCode = 1; });
}
