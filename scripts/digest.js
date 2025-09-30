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
  const hasUseful = items.length > 0;

  const itemBlocks = hasUseful
    ? items
        .map((it) => {
          const proj = (it.projects || [])[0];
          return `
        <div style="border:1px solid #eee;border-radius:8px;padding:16px;margin:16px 0;background:#f9f9f9;">
          <h3 style="margin:0 0 8px 0;">${it.title || "(untitled)"}</h3>
          <p style="margin:0 0 8px 0;font-size:0.9em;color:#666;">${it.url ? `<a href="${it.url}">${it.url}</a>` : ""}</p>
          <p style="margin:0 0 8px 0;"><strong>${proj?.usefulness || "LOW"}:</strong> ${proj?.reason || ""}</p>
          ${proj?.nextSteps ? `<p style="margin:0 0 8px 0;"><em>Next steps:</em> ${proj.nextSteps}</p>` : ""}
          ${it.summary ? `<p style="margin:0;">${it.summary}</p>` : ""}
        </div>`;
        })
        .join("\n")
    : `<div style="padding:16px;background:#eef6ff;border-radius:8px;margin:16px 0;">
        <p>There are no highly or moderately useful items today.</p>
        <p><strong>Stay Calm and Build On.</strong></p>
      </div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Daily Digest – ${date}</title>
</head>
<body style="font-family:sans-serif;line-height:1.5;color:#222;background:#fff;margin:0;padding:0;">
  <div style="background:#0a3d91;color:#fff;padding:20px;">
    <h1 style="margin:0;">Daily Digest – ${date}</h1>
    <p style="margin:0;">News You Can Use Today</p>
  </div>
  <div style="padding:20px;">
    ${itemBlocks}
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
