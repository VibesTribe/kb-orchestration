// scripts/digest.js
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
    });
  }
  return out;
}

// ---- Renderers (keep the clean HTML you liked)
function renderHtml(date, items) {
  if (!items.length) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Daily Digest – ${date}</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f6f6f6; margin: 0; padding: 0; }
    .container { width: 100%; max-width: 700px; margin: 20px auto; background-color: #ffffff;
      border-radius: 8px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }
    .header { padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; font-weight: normal; color: #222; }
    .date { font-size: 14px; margin-top: 4px; color: #666; }
    .message { padding: 20px; font-size: 14px; color: #333; }
    .footer { background-color: #f1f1f1; text-align: center; padding: 15px; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Daily Digest</h1>
      <div class="date">${date}</div>
    </div>
    <div class="message">
      <p>There are no highly or moderately useful items today.</p>
      <p><strong>Stay Calm and Build On.</strong></p>
    </div>
    <div class="footer">
      You are receiving this digest from Knowledgebase.<br/>
      <a href="#">Unsubscribe</a> · <a href="#">View Repo</a>
    </div>
  </div>
</body>
</html>`;
  }

  const cards = items.map((it) => {
    const isHigh = it.usefulness === "HIGH";
    const cardClass = isHigh ? "high" : "moderate";
    const whyColor = isHigh ? "#1b6f5a" : "#553c9a";
    return `
      <div class="digest-card ${cardClass}">
        <h3>${isHigh ? "Highly Useful" : "Moderately Useful"}</h3>
        <p class="title">${escapeHtml(it.title)}</p>
        ${it.summary ? `<p class="text">${escapeHtml(it.summary)}</p>` : ""}
        ${it.reason ? `<p class="meta"><em style="color:${whyColor}">Why it matters:</em><span style="color:${whyColor}"> ${escapeHtml(it.reason)}</span></p>` : ""}
        ${it.nextSteps ? `<p class="meta"><em style="color:${whyColor}">Next steps:</em><span style="color:${whyColor}"> ${escapeHtml(it.nextSteps)}</span></p>` : ""}
        <p class="published">Published: ${escapeHtml(it.publishedAt || date)}</p>
        ${it.url ? `<a href="${escapeHtml(it.url)}">Go to source</a>` : ""}
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Daily Digest – ${date}</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f6f6f6; margin: 0; padding: 0; }
    .container { width: 100%; max-width: 700px; margin: 20px auto; background-color: #ffffff;
      border-radius: 8px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }
    .header { padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; font-weight: normal; color: #222; }
    .date { font-size: 14px; margin-top: 4px; color: #666; }
    .digest-card { padding: 15px; margin: 12px 20px; border-radius: 6px; border-left: 6px solid; }
    .digest-card.high { border-left-color: #38a169; background-color: #f9fdfa; }
    .digest-card.moderate { border-left-color: #805ad5; background-color: #f9f7fd; }
    .digest-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; text-transform: uppercase; }
    .digest-card.high h3 { color: #1b6f5a; }
    .digest-card.moderate h3 { color: #553c9a; }
    .digest-card p.title { margin: 0 0 6px; font-size: 15px; font-weight: 500; color: #222; }
    .digest-card p.text { margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: #333; }
    .digest-card p.meta { margin: 0 0 4px; font-size: 14px; }
    .digest-card p.published { margin: 0 0 6px; font-size: 11px; color: #555; }
    .digest-card a { color: #2b6cb0; text-decoration: none; font-size: 14px; }
    .footer { background-color: #f1f1f1; text-align: center; padding: 15px; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Daily Digest</h1>
      <div class="date">${date}</div>
    </div>
    ${cards}
    <div class="footer">
      You are receiving this digest from Knowledgebase.<br/>
      <a href="#">Unsubscribe</a> · <a href="#">View Repo</a>
    </div>
  </div>
</body>
</html>`;
}

function renderText(date, items) {
  if (!items.length) {
    return `Daily Digest – ${date}\n\nThere are no highly or moderately useful items today.\nStay Calm and Build On.`;
  }
  return `Daily Digest – ${date}\n\n${items
    .map((it) => {
      return `- ${it.title}
  URL: ${it.url}
  Usefulness: ${it.usefulness}
  Why: ${it.reason}
  Next steps: ${it.nextSteps}
  Summary: ${it.summary}`;
    })
    .join("\n\n")}`;
}

function renderJson(date, items) {
  return {
    date,
    count: items.length,
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      url: it.url,
      usefulness: it.usefulness,
      reason: it.reason,
      nextSteps: it.nextSteps,
      summary: it.summary
    })),
    note: items.length
      ? undefined
      : "There are no highly or moderately useful items today. Stay Calm and Build On."
  };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Email (Brevo)
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
  } catch (err) {
    log("Failed to send Brevo email", { error: err.message });
  }
}

export async function digest() {
  // 1) Load knowledge.json (source of truth)
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });

  // 2) Build useful entries (HIGH/MODERATE across any project)
  const entries = buildUsefulEntries(knowledge);
  const date = todayIsoDate();
  const stamp = safeFilenameDate();

  // Tally for subject/logging
  const highCount = entries.filter((e) => e.usefulness === "HIGH").length;
  const modCount = entries.filter((e) => e.usefulness === "MODERATE").length;

  // 3) Prepare output dirs
  const runDir = path.join(DIGEST_DIR, date, stamp);
  const dailyDir = path.join(DIGEST_DIR, date);
  const latestDir = path.join(DIGEST_DIR, "latest");
  await ensureDir(runDir);
  await ensureDir(dailyDir);
  await ensureDir(latestDir);

  // 4) Render artifacts
  const html = renderHtml(date, entries);
  const txt = renderText(date, entries);
  const json = renderJson(date, entries);

  // 5) Write all variants (timestamped, daily, latest)
  const files = {
    // timestamped
    html: path.join(runDir, "digest.html"),
    txt: path.join(runDir, "digest.txt"),
    json: path.join(runDir, "digest.json"),
    // daily stable
    daily_html: path.join(dailyDir, "digest.html"),
    daily_txt: path.join(dailyDir, "digest.txt"),
    daily_json: path.join(dailyDir, "digest.json"),
    // latest pointer
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

  log("Digest built", { date, count: entries.length, high: highCount, moderate: modCount });

  // 6) Email — always send (fallback or normal)
  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
  } else {
    const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
    if (!recipients.length) {
      log("BREVO_TO not configured; skipping email send");
    } else {
      const subject = entries.length
        ? `Daily Digest – ${highCount} HIGH + ${modCount} MODERATE`
        : `Daily Digest – No actionable items today`;
      if (!entries.length) {
        log("📧 Sending fallback digest email (no actionable items)", { recipients });
      } else {
        log("📧 Sending digest email", { recipients, high: highCount, moderate: modCount });
      }
      await sendBrevoEmail({
        subject,
        textContent: txt,
        htmlContent: html,
        recipients
      });
    }
  }

  // 7) Return descriptor so run-pipeline can publish + sync to knowledgebase
  return { date, files, dir: runDir, payload: json };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((err) => {
    console.error("Digest step failed", err);
    process.exitCode = 1;
  });
}
