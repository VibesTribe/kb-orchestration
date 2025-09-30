import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, loadJson } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const DIGEST_DIR = path.join(DATA, "digest");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
function safeFilenameDate() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- Choose the best classification per item (HIGH > MODERATE). Return null if none.
function bestClass(item) {
  const classes = Array.isArray(item.projects) ? item.projects : [];
  const high = classes.find((p) => p.usefulness === "HIGH");
  if (high) return high;
  const moderate = classes.find((p) => p.usefulness === "MODERATE");
  if (moderate) return moderate;
  return null;
}

// ---- Build digest entries from knowledge.json
function buildUsefulEntries(knowledge) {
  const out = [];
  for (const it of knowledge.items || []) {
    const cls = bestClass(it);
    if (!cls) continue;
    out.push({
      id: it.id,
      title: it.title || "(untitled)",
      url: it.url || "",
      summary: it.summary || "",
      usefulness: cls.usefulness, // HIGH or MODERATE
      reason: cls.reason || "",
      nextSteps: cls.nextSteps || "",
      publishedAt: it.publishedAt || it.createdAt || "",
      project: cls.project || "General"
    });
  }
  // Sort so HIGH always come before MODERATE
  out.sort((a, b) => {
    if (a.usefulness === b.usefulness) return 0;
    return a.usefulness === "HIGH" ? -1 : 1;
  });
  return out;
}

// ---- Aggregate token usage from knowledge.json (combined totals per model)
function aggregateUsage(knowledge) {
  const totals = {};
  for (const it of knowledge.items || []) {
    if (it.usage?.enrich) {
      const u = it.usage.enrich;
      const key = `${u.provider}:${u.model}`;
      totals[key] = totals[key] || { total: 0, count: 0 };
      totals[key].total += u.totalTokens || 0;
      totals[key].count += 1;
    }
    if (it.usage?.classify) {
      for (const [, u] of Object.entries(it.usage.classify)) {
        const key = `${u.provider}:${u.model}`;
        totals[key] = totals[key] || { total: 0, count: 0 };
        totals[key].total += u.totalTokens || 0;
        totals[key].count += 1;
      }
    }
  }
  return totals;
}

// ---- Renderers (HTML/Text/JSON)
function renderUsageHtml(usage) {
  const rows = [];
  for (const [model, stats] of Object.entries(usage)) {
    rows.push(`<li>${model} — ${stats.total} tokens</li>`);
  }
  if (!rows.length) return "";
  return `
    <div class="token-usage">
      <h3>Token Usage (this run)</h3>
      <ul>${rows.join("\n")}</ul>
    </div>`;
}

function renderUsageText(usage) {
  const lines = [];
  for (const [model, stats] of Object.entries(usage)) {
    lines.push(`${model}: ${stats.total} tokens (${stats.count} items)`);
  }
  return lines.length ? `\n\nToken Usage:\n${lines.join("\n")}` : "";
}

function renderHtml(date, items, usage, changelog = []) {
  const grouped = {};
  for (const it of items) {
    if (!grouped[it.project]) grouped[it.project] = { HIGH: [], MODERATE: [] };
    grouped[it.project][it.usefulness].push(it);
  }

  const sections = Object.entries(grouped).map(([project, groups]) => {
    const highCards = groups.HIGH.map((it) => `
      <div class="digest-card high">
        <p class="title">${escapeHtml(it.title)}</p>
        ${it.summary ? `<p class="text">${escapeHtml(it.summary)}</p>` : ""}
        ${it.reason ? `<p class="meta"><em>Why it matters:</em> <span>${escapeHtml(it.reason)}</span></p>` : ""}
        ${it.nextSteps ? `<p class="meta"><em>Next steps:</em> <span>${escapeHtml(it.nextSteps)}</span></p>` : ""}
        <p class="published">Published: ${escapeHtml(it.publishedAt || date)}</p>
        ${it.url ? `<a href="${escapeHtml(it.url)}">Go to source</a>` : ""}
      </div>`).join("\n");

    const modCards = groups.MODERATE.map((it) => `
      <div class="digest-card moderate">
        <p class="title">${escapeHtml(it.title)}</p>
        ${it.summary ? `<p class="text">${escapeHtml(it.summary)}</p>` : ""}
        ${it.reason ? `<p class="meta"><em>Why it matters:</em> <span>${escapeHtml(it.reason)}</span></p>` : ""}
        ${it.nextSteps ? `<p class="meta"><em>Next steps:</em> <span>${escapeHtml(it.nextSteps)}</span></p>` : ""}
        <p class="published">Published: ${escapeHtml(it.publishedAt || date)}</p>
        ${it.url ? `<a href="${escapeHtml(it.url)}">Go to source</a>` : ""}
      </div>`).join("\n");

    return `
      <div class="section">
        ${highCards ? `<h2>${project} – Highly Useful</h2>${highCards}` : ""}
        ${modCards ? `<h2>${project} – Moderately Useful</h2>${modCards}` : ""}
      </div>`;
  }).join("\n");

  const changelogSection = changelog.length
    ? `
    <div class="changelog">
      <h3>Recent Changelog Notes</h3>
      <ul>
        ${changelog.map(c => `<li>${escapeHtml(c)}</li>`).join("\n")}
      </ul>
    </div>`
    : `
    <div class="changelog">
      <h3>Recent Changelog Notes</h3>
      <p>No recent changelog notes available.</p>
    </div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Daily Digest – ${date}</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f6f6f6; margin: 0; padding: 0; }
    .container { width: 100%; max-width: 700px; margin: 20px auto; background-color: #ffffff;
      border-radius: 8px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }
    .header { padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; font-weight: normal; color: #222; }
    .date { font-size: 14px; margin-top: 4px; color: #666; }
    h2 { margin: 6px 20px 4px 20px; font-size: 18px; font-weight: normal; color: #333; }
    .digest-card { padding: 15px; margin: 6px 20px; border-radius: 6px; border-left: 6px solid; }
    .digest-card.high { border-left-color: #38a169; background-color: #f9fdfa; }
    .digest-card.moderate { border-left-color: #805ad5; background-color: #f9f7fd; }
    .digest-card p.title { margin: 0 0 6px; font-size: 13px; font-weight: 500; color: #222; }
    .digest-card p.text { margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: #333; }
    .digest-card p.meta { margin: 0 0 4px; font-size: 14px; }
    .digest-card.high p.meta em, .digest-card.high p.meta span { color: #1b6f5a; }
    .digest-card.moderate p.meta em, .digest-card.moderate p.meta span { color: #553c9a; }
    .digest-card p.published { margin: 0 0 6px; font-size: 11px; color: #555; }
    .digest-card a { color: #2b6cb0; text-decoration: none; font-size: 14px; }
    .section { margin: 6px 0; padding-bottom: 4px; border-bottom: 1px solid #eee; }
    .token-usage { margin: 6px 20px; font-size: 13px; color: #444; border-top: 1px solid #eee; padding: 6px 0; }
    .token-usage h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
    .token-usage ul { margin: 0; padding-left: 18px; }
    .changelog { margin: 6px 20px; font-size: 13px; color: #444; border-top: 1px solid #eee; border-bottom: 1px solid #eee; padding: 6px 0; }
    .changelog h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: #444; }
    .changelog ul { margin: 0; padding-left: 18px; }
    .footer { text-align: center; padding: 6px 20px; font-size: 14px; color: #444; font-weight: 500; background: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Daily Digest</h1>
      <div class="date">${date}</div>
    </div>

    ${sections}

    ${renderUsageHtml(usage)}

    ${changelogSection}

    <div class="footer">
      You can still browse all recent updates, even those not flagged as useful.<br/>
      <a href="#">View this digest on KB-site</a>
    </div>
  </div>
</body>
</html>`;
}

function renderText(date, items, usage, changelog = []) {
  let body;
  if (!items.length) {
    body = `Daily Digest – ${date}\n\nNo highly or moderately useful items today.\nStay Calm and Build On.`;
  } else {
    body = `Daily Digest – ${date}\n\n${items.map(it => `- ${it.title}
  URL: ${it.url}
  Usefulness: ${it.usefulness}
  Why: ${it.reason}
  Next steps: ${it.nextSteps}
  Summary: ${it.summary}`).join("\n\n")}`;
  }

  const usageText = renderUsageText(usage);

  const changelogText = changelog.length
    ? `\n\nRecent Changelog Notes:\n${changelog.map(c => `- ${c}`).join("\n")}`
    : `\n\nRecent Changelog Notes:\n- No recent changelog notes available.`;

  return `${body}${usageText}${changelogText}`;
}

function renderJson(date, items, usage) {
  return { date, count: items.length, items, usage };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Email (Brevo)
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
        htmlContent
      })
    });
    if (!res.ok) throw new Error(`Brevo error: ${res.status} ${await res.text()}`);
    log("Digest email sent", { recipients: recipients.length });
  } catch (err) {
    log("Failed to send Brevo email", { error: err.message });
  }
}

export async function digest() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const entries = buildUsefulEntries(knowledge);
  const usage = aggregateUsage(knowledge);
  const changelog = knowledge.changelog || [];
  const date = todayIsoDate();
  const stamp = safeFilenameDate();

  const runDir = path.join(DIGEST_DIR, date, stamp);
  const dailyDir = path.join(DIGEST_DIR, date);
  const latestDir = path.join(DIGEST_DIR, "latest");
  await ensureDir(runDir); await ensureDir(dailyDir); await ensureDir(latestDir);

  const html = renderHtml(date, entries, usage, changelog);
  const txt = renderText(date, entries, usage, changelog);
  const json = renderJson(date, entries, usage);

  const files = {
    html: path.join(runDir, "digest.html"),
    txt: path.join(runDir, "digest.txt"),
    json: path.join(runDir, "digest.json"),
    daily_html: path.join(dailyDir, "digest.html"),
    daily_txt: path.join(dailyDir, "digest.txt"),
    daily_json: path.join(dailyDir, "digest.json"),
    latest_html: path.join(latestDir, "digest.html"),
    latest_txt: path.join(latestDir, "digest.txt"),
    latest_json: path.join(latestDir, "digest.json")
  };
  await fs.writeFile(files.html, html, "utf8");
  await fs.writeFile(files.txt, txt, "utf8");
  await fs.writeFile(files.json, JSON.stringify(json, null, 2), "utf8");
  await fs.writeFile(files.daily_html, html, "utf8");
  await fs.writeFile(files.daily_txt, txt, "utf8");
  await fs.writeFile(files.daily_json, JSON.stringify(json, null, 2), "utf8");
  await fs.writeFile(files.latest_html, html, "utf8");
  await fs.writeFile(files.latest_txt, txt, "utf8");
  await fs.writeFile(files.latest_json, JSON.stringify(json, null, 2), "utf8");

  const highCount = entries.filter((e) => e.usefulness === "HIGH").length;
  const modCount = entries.filter((e) => e.usefulness === "MODERATE").length;
  log("Digest built", { date, count: entries.length, high: highCount, moderate: modCount, usage, changelog });

  if (BREVO_API_KEY) {
    const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
    if (recipients.length) {
      const subject = entries.length
        ? `Daily Digest – ${highCount} HIGH + ${modCount} MODERATE`
        : `Daily Digest – No actionable items today`;
      await sendBrevoEmail({ subject, textContent: txt, htmlContent: html, recipients });
    }
  }

  return { date, files, dir: runDir, payload: json };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((err) => { console.error("Digest step failed", err); process.exitCode = 1; });
}
