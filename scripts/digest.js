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
const USAGE_FILE = path.join(ROOT_DIR, "data", "cache", "pipeline-usage.json");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

/**
 * Convert tokens to a compact "~19.3k" style string.
 */
function tokensToK(total) {
  if (!total || typeof total !== "number" || !isFinite(total)) return "0k";
  return `${Math.round(total / 100) / 10}k`;
}

/**
 * Build a per-model total across all stages from payload.tokenUsage
 * tokenUsage shape:
 * {
 *   enrich: { modelA: { total }, modelB: { total } },
 *   classify: { modelA: { total }, ... },
 *   totalTokens: <number>
 * }
 */
function modelTotalsFromTokenUsage(tokenUsage) {
  const map = new Map();
  for (const [stage, models] of Object.entries(tokenUsage || {})) {
    if (stage === "totalTokens") continue;
    for (const [model, stats] of Object.entries(models || {})) {
      const prev = map.get(model) || 0;
      map.set(model, prev + (stats?.total || 0));
    }
  }
  return map; // Map<model, totalTokens>
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

  // Build per-project sections and checkpoint after each to preserve progress
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

  // Attach token usage for footer (safe if file missing)
  const usage = await loadJson(USAGE_FILE, { runs: [] });
  const latestRun = usage.runs?.[usage.runs.length - 1];
  if (latestRun?.stages) {
    const totalTokens = Object.values(latestRun.stages)
      .flatMap((stage) => Object.values(stage || {}))
      .reduce((sum, m) => sum + (m?.total || 0), 0);

    digestPayload.tokenUsage = { ...latestRun.stages, totalTokens };
    // Re-save artifacts so the footer appears in the final files
    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveTextCheckpoint(htmlPath, renderHtmlDigest(digestPayload));
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

  lines.push("You can still browse all recent updates, even those not flagged as useful:");
  lines.push("View this digest on KB-site: https://vibestribe.github.io/kb-site/");
  lines.push("");

  // ---- Token usage footer (optional) ----
  if (payload.tokenUsage && payload.tokenUsage.totalTokens) {
    const modelTotals = modelTotalsFromTokenUsage(payload.tokenUsage);
    const parts = [];
    for (const [model, total] of modelTotals.entries()) {
      parts.push(`${model} ${tokensToK(total)}`);
    }
    lines.push(
      `Token usage this run: ~${tokensToK(payload.tokenUsage.totalTokens)} (${parts.join(", ")}).`
    );
  }

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
  // A clean, self-contained HTML with a token-usage footer.
  // If you already have a preferred template, you can replace just this function's body.

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const section = (title) => `
    <h3 style="margin:16px 0 8px 0;">${esc(title)}</h3>
  `;

  const entryHtml = (e) => `
    <div style="margin:8px 0 16px 0; line-height:1.4;">
      <div style="font-weight:600;">${esc(e.title)}</div>
      ${e.summary ? `<div>${esc(e.summary)}</div>` : ""}
      ${e.reason ? `<div><em>Why it matters:</em> ${esc(e.reason)}</div>` : ""}
      ${e.nextSteps ? `<div><em>Next steps:</em> ${esc(e.nextSteps)}</div>` : ""}
      ${e.publishedAt ? `<div><em>Published:</em> ${esc(e.publishedAt)}</div>` : ""}
      ${e.url ? `<div><a href="${esc(e.url)}" target="_blank" rel="noopener">Go to source</a></div>` : ""}
    </div>
  `;

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(payload.subject || "Daily Digest")}</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:#111; margin:0; padding:0; background:#f7f7f8;">
  <div style="max-width:720px; margin:0 auto; padding:24px;">
    <h1 style="margin:0 0 6px 0;">Daily Digest</h1>
    <div style="color:#555; margin-bottom:16px;">${esc(dateStr)}</div>
    <div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; margin-bottom:16px;">
      <div style="font-weight:600; margin-bottom:8px;">News You Can Use Today</div>
      <div>${esc(`${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`)}</div>
    </div>
`;

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
      ${
        project.changelog?.slice(0, 5).map(n => `<div>- ${esc(n)}</div>`).join("") || ""
      }
    </div>`;
  }

  html += `
    <div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; margin:16px 0;">
      <div>You can still browse all recent updates, even those not flagged as useful.</div>
      <div><a href="https://vibestribe.github.io/kb-site/" target="_blank" rel="noopener">View this digest on KB-site</a></div>
    </div>
`;

  // ---- Token usage footer (optional) ----
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
