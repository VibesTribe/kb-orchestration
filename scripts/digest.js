// scripts/digest.js
// Builds daily digest artifacts (HTML, JSON, TXT) from knowledge.json.
// Outputs into data/digest/{date}/{timestamp}/ + data/digest/latest/
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

// ---------- Text + JSON renderers unchanged ----------
function renderText(date, items) {
  if (!items.length) {
    return `Daily Digest – ${date}\n\nThere are no highly or moderately useful items today.\nStay Calm and Build On.`;
  }
  return `Daily Digest – ${date}\n\n${items
    .map((it) => {
      const proj = (it.projects || [])[0];
      return `- ${it.title || "(untitled)"}\n  URL: ${it.url || ""}\n  Usefulness: ${proj?.usefulness || "LOW"}\n  Why: ${proj?.reason || ""}\n  Next steps: ${proj?.nextSteps || ""}\n  Summary: ${it.summary || ""}`;
    })
    .join("\n\n")}`;
}

function renderJson(date, items) {
  return {
    date,
    count: items.length,
    items: items.map((it) => {
      const proj = (it.projects || [])[0] || {};
      return {
        id: it.id,
        title: it.title,
        url: it.url,
        usefulness: proj.usefulness || "LOW",
        reason: proj.reason || "",
        nextSteps: proj.nextSteps || "",
        summary: it.summary || ""
      };
    }),
    note: items.length
      ? undefined
      : "There are no highly or moderately useful items today. Stay Calm and Build On."
  };
}

// ---------- Main ----------
export async function digest() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const date = todayIsoDate();
  const stamp = safeFilenameDate();

  // Only include HIGH or MODERATE usefulness items
  const useful = knowledge.items.filter((it) =>
    (it.projects || []).some(
      (p) => p.usefulness === "HIGH" || p.usefulness === "MODERATE"
    )
  );

  const outDir = path.join(DIGEST_DIR, date, stamp);
  const latestDir = path.join(DIGEST_DIR, "latest");
  await ensureDir(outDir);
  await ensureDir(latestDir);

  const html = renderHtml(date, useful);
  const txt = renderText(date, useful);
  const json = renderJson(date, useful);

  const files = {
    html: path.join(outDir, "digest.html"),
    txt: path.join(outDir, "digest.txt"),
    json: path.join(outDir, "digest.json"),
  };

  await fs.writeFile(files.html, html, "utf8");
  await fs.writeFile(files.txt, txt, "utf8");
  await fs.writeFile(files.json, JSON.stringify(json, null, 2), "utf8");

  // Update latest/
  await fs.writeFile(path.join(latestDir, "digest.html"), html, "utf8");
  await fs.writeFile(path.join(latestDir, "digest.txt"), txt, "utf8");
  await fs.writeFile(path.join(latestDir, "digest.json"), JSON.stringify(json, null, 2), "utf8");

  log("Digest built", { date, count: useful.length });
  return { date, files, dir: outDir, payload: json };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((err) => {
    console.error("Digest step failed", err);
    process.exitCode = 1;
  });
}
