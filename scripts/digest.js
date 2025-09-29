// scripts/digest.js
// Daily digest builder — now pulls directly from knowledge.json (post-classify results).

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
import { syncDigest } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json"); // ✅ NEW
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const USAGE_FILE = path.join(ROOT_DIR, "data", "cache", "pipeline-usage.json");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

function log(message, context = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${ts}] ${message}${payload}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tokensToK(total) {
  if (!total || typeof total !== "number" || !isFinite(total)) return "0k";
  return `${Math.round(total / 100) / 10}k`;
}

function modelTotalsFromTokenUsage(tokenUsage) {
  const map = new Map();
  for (const [stage, models] of Object.entries(tokenUsage || {})) {
    if (stage === "totalTokens") continue;
    for (const [model, stats] of Object.entries(models || {})) {
      const prev = map.get(model) || 0;
      map.set(model, prev + (stats?.total || 0));
    }
  }
  return map;
}

export async function digest() {
  // ✅ Directly load knowledge.json
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!knowledge.items.length) {
    log("No knowledge items found; skip digest");
    return null;
  }

  const projects = await loadProjects();
  const projectMap = new Map(projects.map((p) => [p.key, p]));

  // Create directory under digest/YYYY-MM-DD/stamp/
  const now = new Date();
  const dayDir = now.toISOString().slice(0, 10);
  const stampDir = now.toISOString().replace(/[:.]/g, "-");
  const digestDir = path.join(DIGEST_ROOT, dayDir, stampDir);
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  const digestPayload = {
    generatedAt: now.toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: []
  };

  for (const [projectKey, project] of projectMap.entries()) {
    const { high, moderate } = collectItemsForProject(knowledge.items, project);
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
    await syncDigest({ files: { json: jsonPath, txt: textPath, html: htmlPath } });
    await sleep(1000);

    log("Checkpoint saved + synced", { project: project.name });
  }

  // Attach token usage footer if available
  const usage = await loadJson(USAGE_FILE, { runs: [] });
  const latestRun = usage.runs?.[usage.runs.length - 1];
  if (latestRun?.stages) {
    const totalTokens = Object.values(latestRun.stages)
      .flatMap((stage) => Object.values(stage || {}))
      .reduce((sum, m) => sum + (m?.total || 0), 0);

    digestPayload.tokenUsage = { ...latestRun.stages, totalTokens };

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveTextCheckpoint(htmlPath, renderHtmlDigest(digestPayload));
    await syncDigest({ files: { json: jsonPath, txt: textPath, html: htmlPath } });
    await sleep(1000);
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

  return {
    dir: digestDir,
    files: { json: jsonPath, txt: textPath, html: htmlPath },
    payload: digestPayload
  };
}

function collectItemsForProject(items, project) {
  const high = [];
  const moderate = [];
  for (const item of items) {
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

// --- RENDERING (unchanged) ---
function renderTextDigest(payload) { /* same as before */ }
function formatTextEntry(entry) { /* same as before */ }
function renderHtmlDigest(payload) { /* same as before */ }

// --- Brevo Email (unchanged) ---
async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) { /* same as before */ }

// --- Project loader (unchanged) ---
async function loadProjects() { /* same as before */ }
async function loadChangelog(pathname) { /* same as before */ }

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((error) => {
    console.error("Digest step failed", error);
    process.exitCode = 1;
  });
}
