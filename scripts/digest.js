// scripts/digest.js
// Builds daily digest artifacts (HTML, JSON, TXT) from knowledge.json.
// Outputs into data/digest/{date}/{timestamp}/ + data/digest/{date}/ + data/digest/latest/
// Idempotent: will output "Stay Calm and Build On" if no HIGH/MODERATE items.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJsonCheckpoint, ensureDir } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const DIGEST_DIR = path.join(DATA, "digest");

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

// ---------- Rendering ----------
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
  </div>
</body>
</html>`;
  }

  const cards = items.map((it) => {
    const proj = (it.projects || [])[0] || {};
    const usefulness = proj.usefulness || "LOW";
    const isHigh = usefulness === "HIGH";
    const cardClass = isHigh ? "high" : "moderate";
    const whyColor = isHigh ? "#1b6f5a" : "#553c9a";

    return `
      <div class="digest-card ${cardClass}">
        <h3>${isHigh ? "Highly Useful" : "Moderately Useful"}</h3>
        <p class="title">${it.title || "(untitled)"}</p>
        ${it.summary ? `<p class="text">${it.summary}</p>` : ""}
        <p class="meta"><em style="color:${whyColor}">Why it matters:</em><span style="color:${whyColor}"> ${proj.reason || ""}</span></p>
        ${proj.nextSteps ? `<p class="meta"><em style="color:${whyColor}">Next steps:</em><span style="color:${whyColor}"> ${proj.nextSteps}</span></p>` : ""}
        <p class="published">Published: ${it.publishedAt || it.createdAt || date}</p>
        ${it.url ? `<a href="${it.url}">Go to source</a>` : ""}
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html>
<hea
