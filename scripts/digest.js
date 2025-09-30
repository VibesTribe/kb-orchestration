// scripts/digest.js
// Daily digest builder — pulls directly from knowledge.json (post-classify results).
// - Generates digest even when no HIGH/MODERATE (with a calm message).
// - Dedupe within a run per project (by id/url).
// - Writes stamped digest at data/digest/YYYY-MM-DD/<stamp>/digest.{json,txt,html}
// - Also writes daily aliases at data/digest/YYYY-MM-DD/digest.* and data/digest/latest/digest.*
// - Immediately syncs digest artifacts to the knowledgebase repo via kb-sync.

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveJsonCheckpoint,
  saveTextCheckpoint,
  ensureDir,
  loadJson,
} from "./lib/utils.js";
import { syncDigest } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");
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
  // Load knowledge.json directly
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!knowledge.items.length) {
    log("No knowledge items found; skip digest");
    return null;
  }

  const projects = await loadProjects();
  const projectMap = new Map(projects.map((p) => [p.key, p]));

  // Create directories
  const now = new Date();
  const dayDir = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const stampDir = now.toISOString().replace(/[:.]/g, "-"); // timestamp for uniqueness
  const stampedDir = path.join(DIGEST_ROOT, dayDir, stampDir);
  const dailyDir = path.join(DIGEST_ROOT, dayDir);
  const latestDir = path.join(DIGEST_ROOT, "latest");
  await ensureDir(stampedDir);
  await ensureDir(dailyDir);
  await ensureDir(latestDir);

  // Paths
  const stamped = {
    json: path.join(stampedDir, "digest.json"),
    txt: path.join(stampedDir, "digest.txt"),
    html: path.join(stampedDir, "digest.html"),
  };
  const daily = {
    json: path.join(dailyDir, "digest.json"),
    txt: path.join(dailyDir, "digest.txt"),
    html: path.join(dailyDir, "digest.html"),
  };
  const latest = {
    json: path.join(latestDir, "digest.json"),
    txt: path.join(latestDir, "digest.txt"),
    html: path.join(latestDir, "digest.html"),
  };

  // Build digest payload
  const payload = {
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

    payload.projects.push(projectDigest);
    payload.totalHigh += high.length;
    payload.totalModerate += moderate.length;
  }

  if (!payload.projects.length) {
    payload.subject = `Daily Digest – 0 Highly Useful + 0 Moderately Useful`;
  } else {
    payload.subject = `Daily Digest – ${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`;
  }

  // Attach token usage footer if available (safe if file missing)
  const usage = await loadJson(USAGE_FILE, { runs: [] });
  const latestRun = usage.runs?.[usage.runs.length - 1];
  if (latestRun?.stages) {
    const totalTokens = Object.values(latestRun.stages)
      .flatMap((stage) => Object.values(stage || {}))
      .reduce((sum, m) => sum + (m?.total || 0), 0);
    payload.tokenUsage = { ...latestRun.stages, totalTokens };
  }

  // Renderers
  const textOut = renderTextDigest(payload);
  const htmlOut = renderHtmlDigest(payload);

  // Save + sync (stamped)
  await saveJsonCheckpoint(stamped.json, payload);
  await saveTextCheckpoint(stamped.txt, textOut);
  await saveTextCheckpoint(stamped.html, htmlOut);
  await syncDigest({ files: { json: stamped.json, txt: stamped.txt, html: stamped.html } });
  await sleep(800);

  // Save + sync (daily aliases overwrite → effectively “consolidated per day”)
  await saveJsonCheckpoint(daily.json, payload);
  await saveTextCheckpoint(daily.txt, textOut);
  await saveTextCheckpoint(daily.html, htmlOut);
  await syncDigest({ files: { json: daily.json, txt: daily.txt, html: daily.html } });
  await sleep(800);

  // Save + sync (latest stable pointer)
  await saveJsonCheckpoint(latest.json, payload);
  await saveTextCheckpoint(latest.txt, textOut);
  await saveTextCheckpoint(latest.html, htmlOut);
  await syncDigest({ files: { json: latest.json, txt: latest.txt, html: latest.html } });
  await sleep(800);

  log("Digest artifacts prepared", {
    stamped: {
      json: path.relative(ROOT_DIR, stamped.json),
      text: path.relative(ROOT_DIR, stamped.txt),
      html: path.relative(ROOT_DIR, stamped.html),
    },
    daily: {
      json: path.relative(ROOT_DIR, daily.json),
      text: path.relative(ROOT_DIR, daily.txt),
      html: path.relative(ROOT_DIR, daily.html),
    },
    latest: {
      json: path.relative(ROOT_DIR, latest.json),
      text: path.relative(ROOT_DIR, latest.txt),
      html: path.relative(ROOT_DIR, latest.html),
    }
  });

  // Email (send even if 0/0 with calm message)
  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
  } else {
    const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
    if (!recipients.length) {
      log("BREVO_TO not configured; skipping email send");
    } else {
      await sendBrevoEmail({
        subject: payload.subject,
        textContent: textOut,
        htmlContent: htmlOut,
        recipients
      });
    }
  }

  // return for publish.js
  return {
    dir: stampedDir,
    files: { json: stamped.json, txt: stamped.txt, html: stamped.html },
    payload
  };
}

function collectItemsForProject(items, project) {
  const high = [];
  const moderate = [];
  const seen = new Set(); // de-dupe within this run, by id/url

  for (const item of (items || [])) {
    // find assignment for this project
    const assignment = (item.projects || []).find(
      (entry) => entry.projectKey === project.key || entry.project === project.name
    );
    if (!assignment) continue;

    const key = item.id || item.url || `${item.title}-${item.publishedAt || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

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
  if (payload.projects.length) {
    lines.push(
      `News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`
    );
  } else {
    lines.push("News You Can Use Today:\n0 Highly Useful + 0 Moderately Useful");
    lines.push("");
    lines.push("No highly or moderately useful items today. Stay Calm and Build On.");
  }
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

// --- HTML RENDERING (styled like your preferred test email) ---
function renderHtmlDigest(payload) {
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

  const badge = (text) => `
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid #d0d7de;background:#f6f8fa;font-size:12px;">
      ${esc(text)}
    </span>`;

  const pill = (text, bg, fg, b) => `
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid ${b};background:${bg};color:${fg};font-weight:600;font-size:12px;">
      ${esc(text)}
    </span>`;

  const section = (title) => `
    <h3 style="margin:18px 0 10px 0;font-size:16px;color:#0b5fff;">${esc(title)}</h3>
  `;

  const entryHtml = (e) => `
    <div style="margin:10px 0 16px 0; line-height:1.5;">
      <div style="font-weight:700;margin-bottom:2px;">${esc(e.title)}</div>
      ${e.summary ? `<div style="color:#1f2328;">${esc(e.summary)}</div>` : ""}
      ${e.reason ? `<div style="margin-top:6px;"><em>Why it matters:</em> ${esc(e.reason)}</div>` : ""}
      ${e.nextSteps ? `<div><em>Next steps:</em> ${esc(e.nextSteps)}</div>` : ""}
      <div style="margin-top:6px;color:#57606a;font-size:12px;">
        ${e.publishedAt ? `<span>${esc(e.publishedAt)}</span>` : ""}
        ${e.sourceType ? `<span>${e.publishedAt ? " · " : ""}${esc(e.sourceType)}</span>` : ""}
      </div>
      ${e.url ? `<div style="margin-top:6px;"><a href="${esc(e.url)}" target="_blank" rel="noopener" style="text-decoration:none;">Go to source ↗</a></div>` : ""}
    </div>
  `;

  const headerStats = payload.projects.length
    ? `${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`
    : `0 Highly Useful + 0 Moderately Useful`;

  let html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#0b1221;">
  <div style="max-width:720px;margin:0 auto;padding:24px;">
    <div style="background:linear-gradient(135deg,#0b5fff 0%,#6d28d9 100%);border-radius:16px;padding:20px 20px 16px 20px;color:#fff;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <h1 style="margin:0;font-size:22px;">Daily Digest</h1>
        ${badge(dateStr)}
      </div>
      <div style="margin-top:10px;font-size:14px;">
        ${pill("News You Can Use Today","#ffffff","##0b1221","#e6e6e6")}
        <span style="margin-left:8px;">${esc(headerStats)}</span>
      </div>
    </div>

    <div style="background:#fff;border:1px solid #eaeef2;border-radius:14px;padding:16px;margin-top:16px;">
`;

  if (!payload.projects.length) {
    html += `
      <div style="padding:12px 8px;font-size:15px;line-height:1.6;">
        No highly or moderately useful items today. <strong>Stay Calm and Build On.</strong>
      </div>
    `;
  } else {
    for (const project of payload.projects) {
      html += `
      <div style="border:1px solid #eaeef2;border-radius:12px;padding:14px;margin:10px 0 16px 0;">
        <h2 style="margin:0 0 6px 0;font-size:18px;color:#0b1221;">${esc(project.name)}</h2>
        ${project.summary ? `<div style="color:#444;margin-bottom:8px;">${esc(project.summary)}</div>` : ""}

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
  }

  html += `
      <div style="border-top:1px solid #eaeef2;margin-top:8px;padding-top:10px;color:#57606a;font-size:14px;">
        You can still browse all recent updates, even those not flagged as useful.<br/>
        <a href="https://vibestribe.github.io/kb-site/" target="_blank" rel="noopener">View this digest on KB-site</a>
      </div>
`;

  if (payload.tokenUsage && payload.tokenUsage.totalTokens) {
    const modelTotals = modelTotalsFromTokenUsage(payload.tokenUsage);
    const parts = [];
    for (const [model, total] of modelTotals.entries()) {
      parts.push(`${esc(model)} ${esc(tokensToK(total))}`);
    }
    html += `
      <div style="color:#98a1b2;font-size:12px;margin-top:10px;">
        Token usage this run: ~${esc(tokensToK(payload.tokenUsage.totalTokens))} (${parts.join(", ")}).
      </div>
    `;
  }

  html += `
    </div>
  </div>
</body>
</html>`;

  return html;
}

// --- Brevo Email ---
async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
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
    if (!res.ok) throw new Error(`Brevo error: ${res.status} ${await res.text()}`);
    log("Digest email sent", { recipients: recipients.length });
  } catch (error) {
    log("Failed to send Brevo email", { error: error.message });
  }
}

async function loadProjects() {
  const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(PROJECTS_ROOT, entry.name);
    const configPath = path.join(projectDir, "project.json");
    const changelogPath = path.join(projectDir, "changelog.md");

    const config = await loadJson(configPath, null);
    if (!config) continue;

    const changelog = await loadChangelog(changelogPath);

    projects.push({
      key: entry.name,
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
