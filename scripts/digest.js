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
  // Sort so HIGH always come before MODERATE
  out.sort((a, b) => {
    if (a.usefulness === b.usefulness) return 0;
    return a.usefulness === "HIGH" ? -1 : 1;
  });
  return out;
}

// ---- Aggregate token usage from knowledge.json
function aggregateUsage(knowledge) {
  const usage = { enrich: {}, classify: {} };
  for (const it of knowledge.items || []) {
    if (it.usage?.enrich) {
      const u = it.usage.enrich;
      const key = `${u.provider}:${u.model}`;
      usage.enrich[key] = usage.enrich[key] || { total: 0, count: 0 };
      usage.enrich[key].total += u.totalTokens || 0;
      usage.enrich[key].count += 1;
    }
    if (it.usage?.classify) {
      for (const [proj, u] of Object.entries(it.usage.classify)) {
        const key = `${u.provider}:${u.model}`;
        usage.classify[key] = usage.classify[key] || { total: 0, count: 0 };
        usage.classify[key].total += u.totalTokens || 0;
        usage.classify[key].count += 1;
      }
    }
  }
  return usage;
}

// ---- Renderers (HTML/Text/JSON)
function renderUsageHtml(usage) {
  const rows = [];
  for (const [stage, models] of Object.entries(usage)) {
    for (const [model, stats] of Object.entries(models)) {
      rows.push(
        `<tr><td>${stage}</td><td>${model}</td><td>${stats.total}</td><td>${stats.count}</td></tr>`
      );
    }
  }
  if (!rows.length) return "";
  return `
    <h2 style="margin:20px 20px 10px;font-size:16px;color:#444">Token Usage</h2>
    <table style="width:90%;margin:0 auto;border-collapse:collapse;font-size:13px;color:#333">
      <thead><tr><th align="left">Stage</th><th align="left">Model</th><th align="right">Tokens</th><th align="right">Items</th></tr></thead>
      <tbody>${rows.join("\n")}</tbody>
    </table>`;
}

function renderUsageText(usage) {
  const lines = [];
  for (const [stage, models] of Object.entries(usage)) {
    for (const [model, stats] of Object.entries(models)) {
      lines.push(`${stage} | ${model}: ${stats.total} tokens (${stats.count} items)`);
    }
  }
  return lines.length ? `\n\nToken Usage:\n${lines.join("\n")}` : "";
}

function renderHtml(date, items, usage) {
  if (!items.length) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Daily Digest – ${date}</title></head>
<body>
  <p>No highly or moderately useful items today.<br/><strong>Stay Calm and Build On.</strong></p>
  ${renderUsageHtml(usage)}
</body>
</html>`;
  }

  const cards = items.map((it) => {
    const isHigh = it.usefulness === "HIGH";
    const label = isHigh ? "Highly Useful" : "Moderately Useful";
    return `<div><h3>${label}</h3><p><strong>${escapeHtml(it.title)}</strong></p><p>${escapeHtml(it.summary)}</p></div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Daily Digest – ${date}</title></head>
<body>
  <h1>Daily Digest (${date})</h1>
  ${cards}
  ${renderUsageHtml(usage)}
</body>
</html>`;
}

function renderText(date, items, usage) {
  if (!items.length) {
    return `Daily Digest – ${date}\n\nNo highly or moderately useful items today.\nStay Calm and Build On.${renderUsageText(usage)}`;
  }
  return `Daily Digest – ${date}\n\n${items.map(it => `- ${it.title}\n  URL: ${it.url}\n  Usefulness: ${it.usefulness}\n  Why: ${it.reason}\n  Next steps: ${it.nextSteps}\n  Summary: ${it.summary}`).join("\n\n")}${renderUsageText(usage)}`;
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
  const date = todayIsoDate();
  const stamp = safeFilenameDate();

  const runDir = path.join(DIGEST_DIR, date, stamp);
  const dailyDir = path.join(DIGEST_DIR, date);
  const latestDir = path.join(DIGEST_DIR, "latest");
  await ensureDir(runDir); await ensureDir(dailyDir); await ensureDir(latestDir);

  const html = renderHtml(date, entries, usage);
  const txt = renderText(date, entries, usage);
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
  log("Digest built", { date, count: entries.length, high: highCount, moderate: modCount, usage });

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
