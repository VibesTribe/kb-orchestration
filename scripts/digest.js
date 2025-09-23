import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

/* ------------------ Local utilities ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
async function saveJsonCheckpoint(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
async function saveTextCheckpoint(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf8");
}
async function saveHtmlCheckpoint(filePath, html) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, html, "utf8");
}
async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
function log(message, context = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${ts}] ${message}${payload}`);
}

/* ------------------ Main digest step ------------------ */
export async function digest() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip digest");
    return;
  }

  const projects = await loadProjects();
  const activeProjects = projects.filter((p) => p.status === "active");
  const projectMap = new Map(activeProjects.map((p) => [p.key, p]));

  const digestDir = path.join(DIGEST_ROOT, curatedRun.dayDir, curatedRun.stampDir);
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  const digestPayload = (await loadJson(jsonPath, null)) || {
    generatedAt: new Date().toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: [],
  };

  for (const [projectKey, project] of projectMap.entries()) {
    if (digestPayload.projects.some((p) => p.key === projectKey)) continue;

    const { high, moderate } = collectItemsForProject(curatedRun.content, project);
    if (!high.length && !moderate.length) continue;

    const projectDigest = {
      key: projectKey,
      name: project.name,
      summary: project.summary,
      high,
      moderate,
      changelog: project.changelog ?? [],
    };

    digestPayload.projects.push(projectDigest);
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;
    digestPayload.subject = `Daily Digest – ${digestPayload.totalHigh} Highly Useful + ${digestPayload.totalModerate} Moderately Useful`;

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveHtmlCheckpoint(htmlPath, renderHtmlDigest(digestPayload));

    log("Checkpoint saved", { project: project.name });
  }

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath),
    html: path.relative(ROOT_DIR, htmlPath),
  });

  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
    return;
  }

  const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length) {
    log("BREVO_TO not configured; skipping email send");
    return;
  }
  if (!digestPayload.projects.length) {
    log("Digest contains no actionable items; skipping email send");
    return;
  }

  await sendBrevoEmail({
    subject: digestPayload.subject,
    textContent: renderTextDigest(digestPayload),
    htmlContent: renderHtmlDigest(digestPayload),
    recipients,
  });
}

/* ------------------ Helpers ------------------ */
function collectItemsForProject(curated, project) {
  const high = [];
  const moderate = [];
  for (const item of curated.items ?? []) {
    const assignment = (item.projects ?? []).find(
      (entry) => entry.projectKey === project.key || entry.project === project.name
    );
    if (!assignment) continue;
    if (assignment.usefulness === "HIGH") high.push(buildDigestEntry(item, assignment));
    else if (assignment.usefulness === "MODERATE")
      moderate.push(buildDigestEntry(item, assignment));
  }
  return { high, moderate };
}
function buildDigestEntry(item, assignment) {
  const published = item.publishedAt
    ? new Date(item.publishedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;
  return {
    title: item.title ?? "(untitled)",
    url: item.url ?? null,
    summary: item.summary ?? item.description ?? "",
    usefulness: assignment.usefulness,
    reason: assignment.reason ?? "",
    nextSteps: assignment.nextSteps ?? "",
    publishedAt: published,
    sourceType: item.sourceType ?? "unknown",
  };
}
function renderTextDigest(payload) {
  const lines = [];
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  lines.push("Daily Digest");
  lines.push(dateStr);
  lines.push(
    `News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`
  );
  lines.push("");
  for (const project of payload.projects) {
    lines.push(project.name);
    if (project.summary) lines.push(project.summary);
    lines.push("");
    if (project.high.length) {
      lines.push("Highly Useful");
      for (const entry of project.high) lines.push(formatTextEntry(entry));
      lines.push("");
    }
    if (project.moderate.length) {
      lines.push("Moderately Useful");
      for (const entry of project.moderate) lines.push(formatTextEntry(entry));
      lines.push("");
    }
    if (project.changelog.length) {
      lines.push("Recent Changelog Notes");
      for (const note of project.changelog.slice(0, 5)) lines.push(`- ${note}`);
      lines.push("");
    }
  }
  lines.push("You can still browse all updates:");
  lines.push("View this digest: https://vibestribe.github.io/kb-site/");
  return lines.join("\n");
}
function formatTextEntry(entry) {
  const lines = [`- ${entry.title}`];
  if (entry.summary) lines.push(`  ${entry.summary}`);
  if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
  if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
  if (entry.publishedAt) lines.push(`  Published: ${entry.publishedAt}`);
  if (entry.url) lines.push(`  Go to source: ${entry.url}`);
  return lines.join("\n");
}
function renderHtmlDigest(payload) {
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `<!DOCTYPE html><html><body><h1>Daily Digest</h1>
  <p>${dateStr}</p>
  <p>${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful</p>
  ${payload.projects
    .map(
      (p) => `<h2>${p.name}</h2>
      ${p.summary ? `<p>${p.summary}</p>` : ""}
      ${p.high.map((e) => `<div><strong>HIGH:</strong> ${e.title}</div>`).join("")}
      ${p.moderate.map((e) => `<div><strong>MODERATE:</strong> ${e.title}</div>`).join("")}
      `
    )
    .join("")}
  <p><a href="https://vibestribe.github.io/kb-site/">View this digest online</a></p>
  </body></html>`;
}
async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: recipients.map((email) => ({ email })),
        subject,
        textContent,
        htmlContent,
      }),
    });
    if (!res.ok) throw new Error(`Brevo error: ${res.status} ${await res.text()}`);
    log("Digest email sent", { recipients: recipients.length });
  } catch (err) {
    log("Failed to send Brevo email", { error: err.message });
  }
}
async function getLatestRun(root) {
  const dayDirs = await listDirectories(root);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();
  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(root, dayDir));
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(root, dayDir, stampDir, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content) return { dayDir, stampDir, content };
    }
  }
  return null;
}
async function loadProjects() {
  const entries = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of entries) {
    const configPath = path.join(PROJECTS_ROOT, dir, "project.json");
    const changelogPath = path.join(PROJECTS_ROOT, dir, "changelog.md");
    const config = await loadJson(configPath, null);
    if (!config) continue;
    const changelog = await loadChangelog(changelogPath);
    projects.push({ key: dir, changelog, ...config });
  }
  return projects;
}
async function loadChangelog(pathname) {
  try {
    const text = await fs.readFile(pathname, "utf8");
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((err) => {
    console.error("Digest step failed", err);
    process.exitCode = 1;
  });
}
