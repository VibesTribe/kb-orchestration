import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

/* ------------------ Utils ------------------ */
async function ensureDir(d){ await fs.mkdir(d,{recursive:true}); }
async function loadJson(f, fb){ try{ return JSON.parse(await fs.readFile(f,"utf8")); }catch{ return fb; } }
async function saveJson(f, d){ await ensureDir(path.dirname(f)); await fs.writeFile(f, JSON.stringify(d,null,2), "utf8"); }
async function listDirectories(p){ try{ const e=await fs.readdir(p,{withFileTypes:true}); return e.filter(x=>x.isDirectory()).map(x=>x.name);}catch{return[];} }
function log(m,ctx={}){ const ts=new Date().toISOString(); console.log(`[${ts}] ${m}${Object.keys(ctx).length?" "+JSON.stringify(ctx):""}`); }

async function getLatestRun(){
  const days = await listDirectories(CURATED_ROOT); if(!days.length) return null;
  days.sort().reverse();
  for(const d of days){
    const stamps = await listDirectories(path.join(CURATED_ROOT,d));
    stamps.sort().reverse();
    for(const s of stamps){
      const itemsPath = path.join(CURATED_ROOT,d,s,"items.json");
      const content = await loadJson(itemsPath, null);
      if(content) return { dayDir:d, stampDir:s, content };
    }
  }
  return null;
}
async function loadProjects(){
  const dirs = await listDirectories(PROJECTS_ROOT);
  const out = [];
  for(const dir of dirs){
    const cfg = await loadJson(path.join(PROJECTS_ROOT, dir, "project.json"), null);
    if(!cfg) continue;
    const changelog = await (async()=>{ try{ return (await fs.readFile(path.join(PROJECTS_ROOT, dir, "changelog.md"),"utf8"))
      .split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith("#")); }catch{ return []; }})();
    out.push({ key: dir, changelog, ...cfg });
  }
  return out;
}

/* ------------------ Digest rendering ------------------ */
function collectItemsForProject(curated, project){
  const high = [], moderate = [];
  for(const it of (curated.items ?? [])){
    const a = (it.projects ?? []).find(e => e.projectKey === project.key || e.project === project.name);
    if(!a) continue;
    if(a.usefulness === "HIGH") high.push(buildEntry(it, a));
    else if(a.usefulness === "MODERATE") moderate.push(buildEntry(it, a));
  }
  return { high, moderate };
}
function buildEntry(item, a){
  const pub = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}) : null;
  return {
    title: item.title ?? "(untitled)",
    url: item.url ?? null,
    summary: item.summary ?? item.description ?? "",
    usefulness: a.usefulness,
    reason: a.reason ?? "",
    nextSteps: a.nextSteps ?? "",
    publishedAt: pub,
    sourceType: item.sourceType ?? "unknown"
  };
}
function formatTextEntry(e){
  const lines = [`- ${e.title}`];
  if(e.summary) lines.push(`  ${e.summary}`);
  if(e.reason) lines.push(`  Why it matters: ${e.reason}`);
  if(e.nextSteps) lines.push(`  Next steps: ${e.nextSteps}`);
  if(e.publishedAt) lines.push(`  Published: ${e.publishedAt}`);
  if(e.url) lines.push(`  Go to source: ${e.url}`);
  return lines.join("\n");
}
function renderTextDigest(payload){
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  const lines = [];
  lines.push("Daily Digest");
  lines.push(dateStr);
  lines.push(`News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`);
  lines.push("");
  for(const p of payload.projects){
    lines.push(p.name);
    if(p.summary) lines.push(p.summary);
    lines.push("");
    if(p.high.length){ lines.push("Highly Useful"); for(const e of p.high) lines.push(formatTextEntry(e)); lines.push(""); }
    if(p.moderate.length){ lines.push("Moderately Useful"); for(const e of p.moderate) lines.push(formatTextEntry(e)); lines.push(""); }
    if(p.changelog.length){ lines.push("Recent Changelog Notes"); for(const note of p.changelog.slice(0,5)) lines.push(`- ${note}`); lines.push(""); }
  }
  lines.push("You can still browse all updates:");
  lines.push("View this digest: https://vibestribe.github.io/kb-site/");
  return lines.join("\n");
}
function renderHtmlDigest(payload){
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  return `<!DOCTYPE html><html><body><h1>Daily Digest</h1>
  <p>${dateStr}</p>
  <p>${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful</p>
  ${payload.projects.map(p => `
    <h2>${p.name}</h2>
    ${p.summary ? `<p>${p.summary}</p>` : ""}
    ${p.high.map(e=>`<div><strong>HIGH:</strong> ${e.title}</div>`).join("")}
    ${p.moderate.map(e=>`<div><strong>MODERATE:</strong> ${e.title}</div>`).join("")}
  `).join("")}
  <p><a href="https://vibestribe.github.io/kb-site/">View this digest online</a></p>
  </body></html>`;
}

/* ------------------ Email ------------------ */
async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }){
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
      to: recipients.map(email => ({ email })),
      subject, textContent, htmlContent
    })
  });
  if(!res.ok) throw new Error(`Brevo error: ${res.status} ${await res.text()}`);
}

/* ------------------ Main ------------------ */
export async function digest(){
  const run = await getLatestRun();
  if(!run){ log("No curated data found; skip digest"); return; }

  const projects = (await loadProjects()).filter(p=>String(p.status).toLowerCase()==="active");
  const digestDir = path.join(DIGEST_ROOT, run.dayDir, run.stampDir);
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  const payload = (await loadJson(jsonPath, null)) || {
    generatedAt: new Date().toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: []
  };

  for(const proj of projects){
    if (payload.projects.some(p=>p.key===proj.key)) continue;
    const { high, moderate } = collectItemsForProject(run.content, proj);
    if(!high.length && !moderate.length) continue;

    payload.projects.push({
      key: proj.key,
      name: proj.name,
      summary: proj.summary,
      high, moderate,
      changelog: proj.changelog ?? []
    });
    payload.totalHigh += high.length;
    payload.totalModerate += moderate.length;
    payload.subject = `Daily Digest – ${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`;

    await saveJson(jsonPath, payload);
    await fs.writeFile(textPath, renderTextDigest(payload), "utf8");
    await fs.writeFile(htmlPath, renderHtmlDigest(payload), "utf8");
  }

  log("Digest artifacts prepared", { json: jsonPath, text: textPath, html: htmlPath });

  if(!BREVO_API_KEY){ log("BREVO_API_KEY missing; skip send"); return; }
  const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
  if(!recipients.length){ log("BREVO_TO not configured; skip send"); return; }
  if(!payload.projects.length){ log("Digest empty; skip send"); return; }

  try{
    await sendBrevoEmail({
      subject: payload.subject,
      textContent: renderTextDigest(payload),
      htmlContent: renderHtmlDigest(payload),
      recipients
    });
    log("Digest email sent", { recipients: recipients.length });
  }catch(e){
    log("Failed to send digest email", { error: e.message });
  }
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch(err => { console.error("Digest step failed", err); process.exitCode = 1; });
}
