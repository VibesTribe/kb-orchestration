// scripts/digest.js
// Build digest artifacts from latest curated run and active projects.
// Saves outputs under data/digest/<day>/<stamp>/ and optionally sends Brevo email
// Uses only BREVO_* secrets you already listed.

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

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveText(file, text) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text, "utf8");
}

async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${payload}`);
}

async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function loadProjects() {
  const entries = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of entries) {
    const configPath = path.join(PROJECTS_ROOT, dir, "project.json");
    const config = await loadJson(configPath, null);
    if (!config) continue;
    const status = (config.status ?? "active").toLowerCase();
    projects.push({ key: dir, status, changelog: (await fs.readFile(path.join(PROJECTS_ROOT, dir, "changelog.md"), "utf8").catch(() => "")).split(/\r?\n/).map(l => l.trim()).filter(Boolean), ...config });
  }
  return projects;
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
      if (content) return { dayDir, stampDir, itemsPath, content };
    }
  }
  return null;
}

function buildDigestEntry(item, assignment) {
  const published = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : null;
  return {
    title: item.title ?? "(untitled)",
    url: item.url ?? null,
    summary: item.summary ?? item.description ?? "",
    usefulness: assignment.usefulness,
    reason: assignment.reason ?? "",
    nextSteps: assignment.nextSteps ?? "",
    publishedAt: published,
    sourceType: item.sourceType ?? "unknown"
  };
}

function collectItemsForProject(curated, project) {
  const high = [];
  const moderate = [];
  for (const item of curated.items ?? []) {
    // item.projects could be array of classification objects
    const assignment = (item.projects ?? []).find(p => p.projectKey === project.key || p.project === project.name);
    if (!assignment) continue;
    if (String(assignment.usefulness).toUpperCase() === "HIGH") high.push(buildDigestEntry(item, assignment));
    else if (String(assignment.usefulness).toUpperCase() === "MODERATE") moderate.push(buildDigestEntry(item, assignment));
  }
  return { high, moderate };
}

function renderTextDigest(payload) {
  const lines = [];
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  lines.push("Daily Digest");
  lines.push(dateStr);
  lines.push("");
  lines.push(`News You Can Use Today: ${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`);
  lines.push("");
  for (const project of payload.projects) {
    lines.push(project.name);
    if (project.summary) lines.push(project.summary);
    lines.push("");
    if (project.high.length) {
      lines.push("Highly Useful");
      for (const entry of project.high) {
        lines.push(`- ${entry.title}`);
        if (entry.summary) lines.push(`  ${entry.summary}`);
        if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
        if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
        if (entry.publishedAt) lines.push(`  Published: ${entry.publishedAt}`);
        if (entry.url) lines.push(`  Go to source: ${entry.url}`);
      }
      lines.push("");
    }
    if (project.moderate.length) {
      lines.push("Moderately Useful");
      for (const entry of project.moderate) {
        lines.push(`- ${entry.title}`);
        if (entry.summary) lines.push(`  ${entry.summary}`);
        if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
        if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
        if (entry.publishedAt) lines.push(`  Published: ${entry.publishedAt}`);
        if (entry.url) lines.push(`  Go to source: ${entry.url}`);
      }
      lines.push("");
    }
    if (project.changelog.length) {
      lines.push("Recent Changelog Notes");
      for (const note of project.changelog.slice(0, 5)) lines.push(`- ${note}`);
      lines.push("");
    }
    lines.push("");
  }
  lines.push("You can still browse all updates:");
  lines.push("View this digest: https://vibestribe.github.io/kb-site/");
  return lines.join("\n");
}

function renderHtmlDigest(payload) {
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const projectHtml = payload.projects.map(p => {
    const highHtml = p.high.map(e => `<div><strong>HIGH:</strong> <a href="${e.url ?? '#'}">${escapeHtml(e.title)}</a><p>${escapeHtml(e.summary)}</p></div>`).join("");
    const modHtml = p.moderate.map(e => `<div><strong>MODERATE:</strong> <a href="${e.url ?? '#'}">${escapeHtml(e.title)}</a><p>${escapeHtml(e.summary)}</p></div>`).join("");
    const changelogHtml = p.changelog.slice(0, 5).map(n => `<li>${escapeHtml(n)}</li>`).join("");
    return `<section><h2>${escapeHtml(p.name)}</h2>${p.summary ? `<p>${escapeHtml(p.summary)}</p>` : ""}${highHtml}${modHtml}${changelogHtml ? `<h3>Recent Changelog Notes</h3><ul>${changelogHtml}</ul>` : ""}</section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Daily Digest</title></head><body><h1>Daily Digest</h1><p>${dateStr}</p><p>${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful</p>${projectHtml}<p><a href="https://vibestribe.github.io/kb-site/">View this digest online</a></p></body></html>`;
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  try {
    if (!BREVO_API_KEY) throw new Error("BREVO_API_KEY missing");
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: recipients.map(email => ({ email })),
        subject,
        textContent,
        htmlContent
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new Error(`Brevo error: ${res.status} ${body}`);
    }
    log("Digest email sent", { recipients: recipients.length });
  } catch (err) {
    log("Failed to send Brevo email", { error: err.message });
  }
}

export async function digest() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip digest");
    return;
  }

  const projects = await loadProjects();
  const activeProjects = projects.filter(p => (p.status ?? "active").toLowerCase() === "active");

  const digestDir = path.join(DIGEST_ROOT, curatedRun.dayDir, curatedRun.stampDir);
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const txtPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  const digestPayload = {
    generatedAt: new Date().toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: []
  };

  for (const project of activeProjects) {
    const { high, moderate } = collectItemsForProject(curatedRun.content, project);
    if (!high.length && !moderate.length) continue;

    digestPayload.projects.push({
      key: project.key,
      name: project.name ?? project.key,
      summary: project.summary ?? "",
      high,
      moderate,
      changelog: project.changelog ?? []
    });
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;
  }

  digestPayload.subject = `Daily Digest – ${digestPayload.totalHigh} Highly Useful + ${digestPayload.totalModerate} Moderately Useful`;

  await saveJson(jsonPath, digestPayload);
  await saveText(txtPath, renderTextDigest(digestPayload));
  await saveText(htmlPath, renderHtmlDigest(digestPayload));

  log("Digest artifacts prepared", { json: path.relative(ROOT_DIR, jsonPath) });

  // Email send: only if configured and there are items
  const recipients = (BREVO_TO || "").split(/[,;\s]+/).filter(Boolean);
  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
    return;
  }
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
    recipients
  });
}

// Run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch(err => {
    console.error("Digest step failed", err);
    process.exitCode = 1;
  });
}
