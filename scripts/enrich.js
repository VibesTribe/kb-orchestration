// scripts/enrich.js
// Enrichment flow with transcript-first, Gemini fallback, rotation otherwise.
// 1) YouTube videos: try transcript → summarize transcript.
// 2) If no transcript: fallback to Gemini (requires GEMINI_API).
// 3) Non-YouTube: use rotation (OpenRouter).
// Incremental checkpoints preserved. No mock data.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { callWithRotation } from "./lib/openrouter.js";
import { callGemini } from "./lib/gemini.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT, "data", "knowledge.json");
const STATE_FILE = path.join(ROOT, "data/cache/enrich-state.json");

// ---------- Logging ----------
function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

// ---------- YouTube transcript utils ----------
function extractYouTubeVideoId(item) {
  if (typeof item.id === "string" && item.id.startsWith("youtube:video:")) {
    return item.id.split(":").pop();
  }
  try {
    const u = new URL(item.url);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "").trim() || null;
    }
  } catch {}
  return null;
}

function safeJoinText(arr) {
  return arr.join(" ").replace(/\s+/g, " ").trim();
}

function parseTimedTextTracks(xml) {
  const tracks = [];
  const trackTagRegex = /<track\s+([^>]+?)\s*\/>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = trackTagRegex.exec(xml)) !== null) {
    const attrs = {};
    let a;
    while ((a = attrRegex.exec(m[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    if (attrs.lang_code) {
      tracks.push({
        lang_code: attrs.lang_code,
        kind: attrs.kind || "",
      });
    }
  }
  return tracks;
}

function pickBestTrack(tracks) {
  if (!tracks.length) return null;
  const en = tracks.filter((t) =>
    t.lang_code.toLowerCase().startsWith("en")
  );
  return (
    en.find((t) => t.kind !== "asr") ||
    en.find((t) => t.kind === "asr") ||
    tracks[0]
  );
}

async function fetchTranscriptTimedText(videoId) {
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(
    videoId
  )}`;
  const listRes = await fetch(listUrl);
  if (!listRes.ok) return null;
  const listXml = await listRes.text();
  const chosen = pickBestTrack(parseTimedTextTracks(listXml));
  if (!chosen) return null;

  const jsonUrl = `https://www.youtube.com/api/timedtext?fmt=json3&v=${encodeURIComponent(
    videoId
  )}&lang=${encodeURIComponent(chosen.lang_code)}`;
  const jsonRes = await fetch(jsonUrl);
  if (jsonRes.ok) {
    try {
      const j = await jsonRes.json();
      const parts = [];
      for (const ev of j.events || []) {
        if (Array.isArray(ev.segs)) {
          for (const seg of ev.segs) {
            if (seg?.utf8) parts.push(seg.utf8);
          }
        }
      }
      const text = safeJoinText(parts);
      if (text) return text;
    } catch {}
  }

  const vttUrl = `https://www.youtube.com/api/timedtext?fmt=vtt&v=${encodeURIComponent(
    videoId
  )}&lang=${encodeURIComponent(chosen.lang_code)}`;
  const vttRes = await fetch(vttUrl);
  if (!vttRes.ok) return null;
  const vtt = await vttRes.text();
  const lines = vtt
    .replace(/^WEBVTT.*$/m, "")
    .split(/\r?\n/)
    .filter(
      (ln) =>
        ln &&
        !/^\d+$/.test(ln) &&
        !/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(ln)
    );
  return safeJoinText(lines) || null;
}

function clampForSummary(text, maxChars = 12000) {
  if (!text || text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n...\n${tail}`;
}

// ---------- Main enrichment ----------
export async function enrich() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  let processedCount = 0;

  for (const item of knowledge.items) {
    if (state.processed.includes(item.id)) continue;

    try {
      let summaryText = null;
      let modelUsed = null;

      const isYouTube =
        item.sourceType === "youtube" ||
        (typeof item.id === "string" && item.id.startsWith("youtube:video:"));

      if (isYouTube) {
        const videoId = extractYouTubeVideoId(item);
        if (videoId) {
          try {
            const transcript = await fetchTranscriptTimedText(videoId);
            if (transcript) {
              item.transcript = transcript;
              const prompt = [
                "Summarize the following YouTube video transcript.",
                "Focus on concrete takeaways, techniques, and details.",
                "",
                `Title: ${item.title ?? "(untitled)"}`,
                `URL: ${item.url ?? "(no url)"}`,
                "",
                clampForSummary(transcript),
              ].join("\n");
              const { text, model } = await callWithRotation(prompt, "enrich");
              summaryText = text;
              modelUsed = model || "rotation-transcript";
              log("Enriched via transcript", { id: item.id, model: modelUsed });
            }
          } catch (e) {
            log("Transcript fetch failed", { id: item.id, error: e.message });
          }
        }
      }

      if (isYouTube && !summaryText) {
        const prompt = [
          "Provide a neutral, detailed summary of this YouTube video.",
          "Include main topics, techniques, pros/cons, and takeaways.",
          "This should be useful for future project classification.",
          "",
          `Title: ${item.title ?? "(untitled)"}`,
          `URL: ${item.url ?? "(no url)"}`,
        ].join("\n");

        const text = await callGemini(prompt);
        summaryText = text;
        modelUsed = "gemini-fallback";
        log("Enriched via Gemini (no transcript)", { id: item.id });
      }

      if (!isYouTube) {
        const prompt = [
          "Summarize this item into a detailed digestible summary.",
          "",
          `Title: ${item.title ?? "(untitled)"}`,
          `URL: ${item.url ?? "(no url)"}`,
          item.description ? `\nDescription: ${item.description}` : "",
        ].join("\n");
        const { text, model } = await callWithRotation(prompt, "enrich");
        summaryText = text;
        modelUsed = model || "rotation-nonYT";
        log("Enriched non-YouTube", { id: item.id, model: modelUsed });
      }

      item.summary = summaryText;
      item.modelUsed = modelUsed;

      state.processed.push(item.id);
      await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
      await saveJsonCheckpoint(STATE_FILE, state);

      processedCount++;
    } catch (err) {
      log("Failed to enrich item", { id: item.id, error: err.message });
    }
  }

  log("Enrich step complete", {
    total: knowledge.items.length,
    processed: processedCount,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich step failed", err);
    process.exitCode = 1;
  });
}
