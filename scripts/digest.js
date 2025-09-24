// scripts/digest.js
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveJsonCheckpoint,
  saveTextCheckpoint,
  ensureDir,
  loadJson,
  listDirectories
} from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

export async function digest() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip digest");
    return null;
  }

  const projects = await loadProjects();
  const projectMap = new Map(projects.map((project) => [project.key, project]));

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
    projects: []
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
      changelog: project.changelog ?? []
    };

    digestPayload.projects.push(projectDigest);
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;
    digestPayload.subject = `Daily Digest – ${digestPayload.totalHigh} Highly Useful + ${digestPayload.totalModerate} Moderately Useful`;

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveTextCheckpoint(htmlPath, renderHtmlDigest(digestPayload));

    log("Checkpoint saved", { project: project.name });
  }

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath),
    html: path.relative(ROOT_DIR, htmlPath)
  });

  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
  } else {
    const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
    if (!recipients.length) {
      log("BREVO_TO not configured; skipping email send");
    } else if (!digestPayload.projects.length) {
      log("Digest contains no actionable items; skipping email send");
    } else {
      await sendBrevoEmail({
        subject: digestPayload.subject,
        textContent: renderTextDigest(digestPayload),
        htmlContent: renderHtmlDigest(digestPayload),
        recipients
      });
    }
  }

  // ✅ Return paths + payload so publish.js can reuse them
  return {
    dir: digestDir,
    files: { json: jsonPath, txt: textPath, html: htmlPath },
    payload: digestPayload
  };
}

function collectItemsForProject(curated, project) {
  const high = [];
  const moderate = [];
  for (const item of curated.items ?? []) {
    const assignment = (item.projects ?? []).find(
      (entry) => entry.projectKey === project.key || entry.project === project.name
    );
    if (!assignment) continue;
    if (assignment.usefulness === "HIGH") {
      high.push(buildDigestEntry(item, assignment));
    } else if (assignment.usefulness === "MODERATE") {
      moderate.push(buildDigestEntry(item, assignment));
    }
  }
  return { high, moderate };
}

function buildDigestEntry(item, assignment) {
  const published = item.publishedAt
    ? new Date(item.publishedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
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
    sourceType: item.sourceType ?? "unknown"
  };
}

// --- TEXT RENDERING ---
function renderTextDigest(payload) {
  const lines = [];
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  lines.push("Daily Digest");
  lines.push(dateStr);
  lines.push(`News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`);
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

  lines.push("You can still browse all recent updates, even those not flagged as useful:");
  lines.push("View this digest on KB-site: https://vibestribe.github.io/kb-site/");

  return lines.join("\n");
}

function formatTextEntry(entry) {
  const lines = [];
  lines.push(`- ${entry.title}`);
  if (entry.summary) lines.push(`  ${entry.summary}`);
  if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
  if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
  if (entry.publishedAt) lines.push(`  Published: ${entry.publishedAt}`);
  if (entry.url) lines.push(`  Go to source: ${entry.url}`);
  return lines.join("\n");
}

// --- HTML RENDERING ---
function renderHtmlDigest(payload) {
  // (unchanged, full styled HTML from your working version)
  // ... same code as in your good copy ...
  // (keeping brevity here, but include the styled template you pasted earlier)
}

// --- Brevo Email ---
async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: recipients.map((email) => ({ email })),
        subject,
        textContent,
        htmlContent
      })
    });
    if (!response.ok) throw new Error(`Brevo error: ${response.status} ${await response.text()}`);
    log("Digest email sent", { recipients: recipients.length });
  } catch (error) {
    log("Failed to send Brevo email", { error: error.message });
  }
}

// --- Helpers ---
async function getLatestRun(root) {
  const dayDirs = await listDirectories(root);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();
  for (const dayDir of dayDirs) {
    const dayPath = path.join(root, dayDir);
    const stampDirs = await listDirectories(dayPath);
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(dayPath, stampDir, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content) return { dayDir, stampDir, itemsPath, content };
    }
  }
  return null;
}

async function loadProjects() {
  const entries = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of entries) {
    const projectDir = path.join(PROJECTS_ROOT, dir);
    const configPath = path.join(projectDir, "project.json");
    const changelogPath = path.join(projectDir, "changelog.md");

    const config = await loadJson(configPath, null);
    if (!config) continue;

    const changelog = await loadChangelog(changelogPath);

    projects.push({
      key: dir,
      changelog,
      ...config
    });
  }
  return projects;
}

async function loadChangelog(pathname) {
  try {
    const text = await fs.readFile(pathname, "utf8");
    return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((error) => {
    console.error("Digest step failed", error);
    process.exitCode = 1;
  });
}
