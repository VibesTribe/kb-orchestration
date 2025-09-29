// scripts/digest.js
// Daily digest builder — builds from knowledge.json, merges same-day runs, dedupes, and preserves history.

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
const DATA_DIR = path.join(ROOT_DIR, "data");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");
const DIGEST_ROOT = path.join(DATA_DIR, "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const USAGE_FILE = path.join(DATA_DIR, "cache", "pipeline-usage.json");

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

function isSameDay(iso, dayStr) {
  if (!iso) return false;
  return String(iso).slice(0, 10) === dayStr;
}

function usefulnessRank(u) {
  return u === "HIGH" ? 2 : u === "MODERATE" ? 1 : 0;
}

// ---------- MAIN ----------
export async function digest() {
  // 1) Load knowledge directly
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items) || !knowledge.items.length) {
    log("No knowledge items found; skip digest");
    return null;
  }

  // 2) Load projects (names/keys used for grouping)
  const projects = await loadProjects();
  const projectMap = new Map(projects.map((p) => [p.key, p]));

  // 3) Day + stamp folders for this run
  const now = new Date();
  const dayDir = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const stampDir = now.toISOString().replace(/[:.]/g, "-"); // safe for FS
  const digestDir = path.join(DIGEST_ROOT, dayDir, stampDir);
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  // 4) Build digest from today's items only (based on ingestedAt)
  const todaysItems = knowledge.items.filter((it) => isSameDay(it.ingestedAt, dayDir));

  let digestPayload = {
    generatedAt: now.toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: []
  };

  for (const [projectKey, project] of projectMap.entries()) {
    const { high, moderate } = collectItemsForProject(todaysItems, project);
    if (!high.length && !moderate.length) continue;
    digestPayload.projects.push({
      key: projectKey,
      name: project.name,
      summary: project.summary,
      high,
      moderate,
      changelog: project.changelog ?? []
    });
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;
  }

  // If nothing today, still produce a minimal digest (and optionally email)
  if (!digestPayload.projects.length) {
    digestPayload.subject = "Daily Digest – No actionable items today";
    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveTextCheckpoint(htmlPath, renderHtmlDigest(digestPayload));
    await syncDigest({ files: { json: jsonPath, txt: textPath, html: htmlPath } });
    await maybeSendEmail(digestPayload);
    log("Digest (empty) prepared + synced", {
      json: path.relative(ROOT_DIR, jsonPath)
    });
    // Clean older runs from same day (keep this newest)
    await cleanupOlderSameDayRuns(dayDir, stampDir);
    return { dir: digestDir, files: { json: jsonPath, txt: textPath, html: htmlPath }, payload: digestPayload };
  }

  // Calculate subject now that totals exist
  digestPayload.subject = `Daily Digest – ${digestPayload.totalHigh} Highly Useful + ${digestPayload.totalModerate} Moderately Useful`;

  // 5) Merge with existing same-day digest (dedupe + “highest usefulness wins”)
  const merged = await mergeWithExistingSameDay(dayDir, digestPayload);

  // 6) Save artifacts and sync upstream
  await saveJsonCheckpoint(jsonPath, merged);
  await saveTextCheckpoint(textPath, renderTextDigest(merged));
  await saveTextCheckpoint(htmlPath, renderHtmlDigest(merged));
  await syncDigest({ files: { json: jsonPath, txt: textPath, html: htmlPath } });
  await sleep(1000);

  // 7) Attach token usage footer (if present)
  const usage = await loadJson(USAGE_FILE, { runs: [] });
  const latestRun = usage.runs?.[usage.runs.length - 1];
  if (latestRun?.stages) {
    const totalTokens = Object.values(latestRun.stages)
      .flatMap((stage) => Object.values(stage || {}))
      .reduce((sum, m) => sum + (m?.total || 0), 0);
    merged.tokenUsage = { ...latestRun.stages, totalTokens };
    await saveJsonCheckpoint(jsonPath, merged);
    await saveTextCheckpoint(textPath, renderTextDigest(merged));
    await saveTextCheckpoint(htmlPath, renderHtmlDigest(merged));
    await syncDigest({ files: { json: jsonPath, txt: textPath, html: htmlPath } });
  }

  await maybeSendEmail(merged);

  // 8) Clean older runs for the same day (keep newest)
  await cleanupOlderSameDayRuns(dayDir, stampDir);

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath),
    html: path.relative(ROOT_DIR, htmlPath)
  });

  return { dir: digestDir, files: { json: jsonPath, txt: textPath, html: htmlPath }, payload: merged };
}

// ---------- BUILDERS ----------
function collectItemsForProject(items, project) {
  const high = [];
  const moderate = [];
  for (const item of items) {
    const assignment = (item.projects ?? []).find(
      (entry) => entry.projectKey === project.key || entry.project === project.name
    );
    if (!assignment) continue;
    const entry = buildDigestEntry(item, assignment);
    if (assignment.usefulness === "HIGH") high.push(entry);
    else if (assignment.usefulness === "MODERATE") moderate.push(entry);
  }
  return { high, moderate };
}

function buildDigestEntry(item, assignment) {
  const published = item.publishedAt
    ? new Date(item.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  return {
    id: item.id, // ✅ include ID so we can dedupe reliably
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

// ---------- MERGE / DEDUPE ----------
async function mergeWithExistingSameDay(dayDir, nextPayload) {
  const dayPath = path.join(DIGEST_ROOT, dayDir);
  const stampDirs = (await safeListDirectories(dayPath)).sort();
  if (!stampDirs.length) return nextPayload;

  const latestStamp = stampDirs[stampDirs.length - 1];
  const latestDigestPath = path.join(dayPath, latestStamp, "digest.json");
  const prev = await loadJson(latestDigestPath, null);
  if (!prev || !Array.isArray(prev.projects)) return nextPayload;

  // Build project map for merging
  const mergedProjects = new Map();

  function upsertProject(proj) {
    if (!proj) return;
    const key = proj.key || proj.name;
    if (!mergedProjects.has(key)) {
      mergedProjects.set(key, {
        key: proj.key,
        name: proj.name,
        summary: proj.summary,
        high: [],
        moderate: [],
        changelog: Array.isArray(proj.changelog) ? proj.changelog.slice(0, 50) : []
      });
    }
    const tgt = mergedProjects.get(key);
    // merge high/moderate with dedupe + highest usefulness wins
    mergeEntryArrays(tgt, proj.high, "HIGH");
    mergeEntryArrays(tgt, proj.moderate, "MODERATE");
  }

  for (const p of prev.projects) upsertProject(p);
  for (const p of nextPayload.projects) upsertProject(p);

  // Finalize counts and subject
  const merged = {
    generatedAt: nextPayload.generatedAt,
    subject: "", // fill below
    totalHigh: 0,
    totalModerate: 0,
    projects: Array.from(mergedProjects.values())
  };

  for (const proj of merged.projects) {
    // Remove from moderate any IDs that exist in high
    if (proj.high?.length && proj.moderate?.length) {
      const highIds = new Set(proj.high.map((e) => e.id));
      proj.moderate = proj.moderate.filter((e) => !highIds.has(e.id));
    }
    merged.totalHigh += proj.high?.length || 0;
    merged.totalModerate += proj.moderate?.length || 0;
  }
  merged.subject = `Daily Digest – ${merged.totalHigh} Highly Useful + ${merged.totalModerate} Moderately Useful`;
  return merged;
}

function mergeEntryArrays(targetProj, entries = [], level) {
  if (!Array.isArray(entries) || !entries.length) return;
  // Keep a master map of id → entry with "highest usefulness wins"
  const map = new Map();
  for (const e of (targetProj.high || [])) map.set(e.id, { entry: e, level: "HIGH" });
  for (const e of (targetProj.moderate || [])) {
    const m = map.get(e.id);
    if (!m || usefulnessRank("MODERATE") > usefulnessRank(m.level)) {
      map.set(e.id, { entry: e, level: "MODERATE" });
    }
  }
  for (const e of entries) {
    const m = map.get(e.id);
    if (!m || usefulnessRank(level) > usefulnessRank(m.level)) {
      map.set(e.id, { entry: e, level });
    }
  }
  // Rebuild arrays
  const highs = [];
  const mods = [];
  for (const { entry, level: lv } of map.values()) {
    if (lv === "HIGH") highs.push(entry);
    else if (lv === "MODERATE") mods.push(entry);
  }
  targetProj.high = highs;
  targetProj.moderate = mods;
}

// ---------- CLEANUP ----------
async function cleanupOlderSameDayRuns(dayDir, keepStampDir) {
  const dayPath = path.join(DIGEST_ROOT, dayDir);
  const dirs = await safeListDirectories(dayPath);
  for (const d of dirs) {
    if (d !== keepStampDir) {
      try {
        await fs.rm(path.join(dayPath, d), { recursive: true, force: true });
      } catch {}
    }
  }
}

async function safeListDirectories(dir) {
  try {
    return (await listDirectories(dir)) || [];
  } catch {
    return [];
  }
}

// ---------- RENDERING ----------
function renderTextDigest(payload) {
  const lines = [];
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  lines.push("Daily Digest");
  lines.push(dateStr);

  if (!payload.projects?.length) {
    lines.push("No actionable items today.");
    lines.push("Stay calm and build on. 💪");
    return lines.join("\n");
  }

  lines.push(
    `News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`
  );
  lines.push("");

  for (const project of payload.projects) {
    lines.push(project.name);
    if (project.summary) lines.push(project.summary);
    lines.push("");

    if (project.high?.length) {
      lines.push("Highly Useful");
      for (const entry of project.high) lines.push(formatTextEntry(entry));
      lines.push("");
    }

    if (project.moderate?.length) {
      lines.push("Moderately Useful");
      for (const entry of project.moderate) lines.push(formatTextEntry(entry));
      lines.push("");
    }

    if (project.changelog?.length) {
      lines.push("Recent Changelog Notes");
      for (const note of project.changelog.slice(0, 5)) lines.push(`- ${note}`);
      lines.push("");
    }
  }

  lines.push("You can still browse all recent updates, even those not flagged as useful:");
  lines.push("View this digest on KB-site: https://vibestribe.github.io/kb-site/");
  lines.push("");

  if (payload.tokenUsage && payload.tokenUsage.totalTokens) {
    const modelTotals = modelTotalsFromTokenUsage(payload.tokenUsage);
    const parts = [];
    for (const [model, total] of modelTotals.entries()) parts.push(`${model} ${tokensToK(total)}`);
    lines.push(`Token usage this run: ~${tokensToK(payload.tokenUsage.totalTokens)} (${parts.join(", ")}).`);
  }

  return lines.join("\n");
}

function formatTextEntry(e) {
  const lines = [];
  lines.push(`- ${e.title}`);
  if (e.summary) lines.push(`  ${e.summary}`);
  if (e.reason) lines.push(`  Why it matters: ${e.reason}`);
  if (e.nextSteps) lines.push(`  Next steps: ${e.nextSteps}`);
  if (e.publishedAt) lines.push(`  Published: ${e.publishedAt}`);
  if (e.url) lines.push(`  Go to source: ${e.url}`);
  return lines.join("\n");
}

function renderHtmlDigest(payload) {
  const esc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });

  const section = (title) => `<h3 style="margin:16px 0 8px 0;">${esc(title)}</h3>`;

  const entryHtml = (e) => `
    <div style="margin:8px 0 16px 0; line-height:1.4;">
      <div style="font-weight:600;">${esc(e.title)}</div>
      ${e.summary ? `<div>${esc(e.summary)}</div>` : ""}
      ${e.reason ? `<div><em>Why it matters:</em> ${esc(e.reason)}</div>` : ""}
      ${e.nextSteps ? `<div><em>Next steps:</em> ${esc(e.nextSteps)}</div>` : ""}
      ${e.publishedAt ? `<div><em>Published:</em> ${esc(e.publishedAt)}</div>` : ""}
      ${e.url ? `<div><a href="${esc(e.url)}" target="_blank" rel="noopener">Go to source</a></div>` : ""}
    </div>`;

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(payload.subject || "Daily Digest")}</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:#111; margin:0; padding:0; background:#f7f7f8;">
  <div style="max-width:720px; margin:0 auto; padding:24px;">
    <h1 style="margin:0 0 6px 0;">Daily Digest</h1>
    <div style="color:#555; margin-bottom:16px;">${esc(dateStr)}</div>`;

  if (!payload.projects?.length) {
    html += `
    <div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; margin-bottom:16px;">
      <div>No actionable items today.</div>
      <div>Stay calm and build on. 💪</div>
    </div>
  </div>
</body>
</html>`;
    return html;
  }

  html += `
    <div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; margin-bottom:16px;">
      <div style="font-weight:600; margin-bottom:8px;">News You Can Use Today</div>
      <div>${esc(`${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`)}</div>
    </div>`;

  for (const project of payload.projects) {
    html += `
    <div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; margin:16px 0;">
      <h2 style="margin:0 0 6px 0;">${esc(project.name)}</h2>
      ${project.summary ? `<div style="color:#444; margin-bottom:8px;">${esc(project.summary)}</div>` : ""}

      ${project.high?.length ? section("Highly Useful") : ""}
      ${project.high?.map(entryHtml).join("") || ""}

      ${project.moderate?.length ? section("Moderately Useful") : ""}
      ${project.moderate?.map(entryHtml).join("") || ""}

      ${project.changelog?.length ? section("Recent Changelog Notes") : ""}
      ${project.changelog?.slice(0, 5).map(n => `<div>- ${esc(n)}</div>`).join("") || ""}
    </div>`;
  }

  html += `
    <div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; margin:16px 0;">
      <div>You can still browse all recent updates, even those not flagged as useful.</div>
      <div><a href="https://vibestribe.github.io/kb-site/" target="_blank" rel="noopener">View this digest on KB-site</a></div>
    </div>`;

  if (payload.tokenUsage && payload.tokenUsage.totalTokens) {
    const modelTotals = modelTotalsFromTokenUsage(payload.tokenUsage);
    const parts = [];
    for (const [model, total] of modelTotals.entries()) {
      parts.push(`${esc(model)} ${esc(tokensToK(total))}`);
    }
    html += `
    <p style="color:#777; font-size:0.9em; margin:0 0 24px 0;">
      Token usage this run: ~${esc(tokensToK(payload.tokenUsage.totalTokens))} (${parts.join(", ")}).
    </p>`;
  }

  html += `
  </div>
</body>
</html>`;

  return html;
}

// ---------- EMAIL ----------
async function maybeSendEmail(payload) {
  const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
  if (!BREVO_API_KEY || !recipients.length) return;

  await sendBrevoEmail({
    subject: payload.subject || "Daily Digest",
    textContent: renderTextDigest(payload),
    htmlContent: renderHtmlDigest(payload),
    recipients
  });
}

async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
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

// ---------- PROJECTS ----------
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
    projects.push({ key: dir, changelog, ...config });
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

// ---------- Entrypoint ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((error) => {
    console.error("Digest step failed", error);
    process.exitCode = 1;
  });
}
