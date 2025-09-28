// scripts/enrich.js
// Enrichment flow focused on high-quality, classification-ready outputs.
// Uses stage-specific model rotation from config/models.json.
// YouTube: transcript → summarize JSON. Non-YouTube: summarize JSON from title/desc.
// Saves incrementally after each item.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

import { callWithRotation } from "./lib/openrouter.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage } from "./lib/token-usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT, "data", "knowledge.json");
const STATE_FILE = path.join(ROOT, "data/cache/enrich-state.json");

// ---------- Logging ----------
function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

// ---------- Helpers ----------
function extractYouTubeVideoId(item) {
  try {
    if (typeof item.id === "string" && item.id.startsWith("youtube:video:")) {
      return item.id.split(":").pop();
    }
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
    while ((a = attrRegex.exec(m[1])) !== null) attrs[a[1]] = a[2];
    if (attrs.lang_code) tracks.push({ lang_code: attrs.lang_code, kind: attrs.kind || "" });
  }
  return tracks;
}
function pickBestTrack(tracks) {
  if (!tracks.length) return null;
  const en = tracks.filter((t) => t.lang_code.toLowerCase().startsWith("en"));
  return en.find((t) => t.kind !== "asr") || en.find((t) => t.kind === "asr") || tracks[0];
}

async function fetchTranscriptTimedText(videoId) {
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  const listRes = await fetch(listUrl);
  if (!listRes.ok) return null;
  const listXml = await listRes.text();
  const chosen = pickBestTrack(parseTimedTextTracks(listXml));
  if (!chosen) return null;

  const jsonUrl = `https://www.youtube.com/api/timedtext?fmt=json3&v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(chosen.lang_code)}`;
  const jsonRes = await fetch(jsonUrl);
  if (jsonRes.ok) {
    try {
      const j = await jsonRes.json();
      const parts = [];
      for (const ev of j.events || []) {
        if (Array.isArray(ev.segs)) for (const seg of ev.segs) if (seg?.utf8) parts.push(seg.utf8);
      }
      const text = safeJoinText(parts);
      if (text) return text;
    } catch {}
  }

  const vttUrl = `https://www.youtube.com/api/timedtext?fmt=vtt&v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(chosen.lang_code)}`;
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

function clamp(text, maxChars = 12000) {
  if (!text || text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n...\n${tail}`;
}

function buildPromptJSON({ item, transcript }) {
  const base = [
    "You are an expert analyst writing neutral enrichment for a knowledgebase.",
    "Return STRICT JSON ONLY (no Markdown), matching exactly this schema:",
    `{
  "summary": "120-250 word neutral, specific summary capturing main ideas, methods, results, caveats.",
  "enrichment": {
    "bullet_points": ["3-6 terse, factual bullets"],
    "keywords": ["5-12 domain terms"],
    "entities": {
      "people": [], "orgs": [], "products": [],
      "tech": [], "standards": []
    },
    "topics": ["2-6 broader topics"],
    "links": []
  }
}`,
    "Rules:",
    "- No meta text like 'As an AI'.",
    "- No requests for more info.",
    "- Cite concrete details from the provided content.",
    "- Keep it neutral and project-agnostic.",
    "",
    `Title: ${item.title ?? "(untitled)"}`,
    `URL: ${item.url ?? "(no url)"}`
  ];

  if (transcript) {
    base.push("", "Content (transcript, possibly truncated):", clamp(transcript));
  } else if (item.description) {
    base.push("", "Content (description):", clamp(item.description, 6000));
  } else {
    base.push("", "Content: Only title and URL are available. Infer cautiously.");
  }

  return base.join("\n");
}

function looksBad(summaryText = "") {
  const s = summaryText.toLowerCase();
  if (s.length < 120) return true;
  const badPhrases = [
    "please provide",
    "i cannot generate",
    "insufficient information",
    "as an ai",
    "cannot summarize",
    "need more information",
  ];
  return badPhrases.some((p) => s.includes(p));
}

function parseStrictJSON(txt) {
  try {
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    if (start >= 0 && end >= start) {
      return JSON.parse(txt.slice(start, end + 1));
    }
  } catch {}
  return null;
}

// ---------- Main enrichment ----------
export async function enrich() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  let processedCount = 0;

  for (const item of knowledge.items) {
    if (state.processed.includes(item.id)) continue;

    try {
      const videoId = extractYouTubeVideoId(item);
      let transcript = null;
      if (videoId) {
        try {
          transcript = await fetchTranscriptTimedText(videoId);
          if (transcript) item.transcript = transcript;
        } catch (e) {
          log("Transcript fetch failed", { id: item.id, error: e.message });
        }
      }

      const prompt = buildPromptJSON({ item, transcript });

      // 🚀 Stage-specific rotation from config/models.json ("enrich")
      const { text, model, rawUsage } = await callWithRotation(prompt, "enrich");
      const parsed = parseStrictJSON(text);

      if (!parsed?.summary || !parsed?.enrichment || looksBad(parsed.summary)) {
        log("Invalid enrichment output", { id: item.id, model });
        // don't mark processed; allow retry next run
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
        continue;
      }

      // Persist enrichment
      item.summary = parsed.summary;
      item.enrichment = {
        bullet_points: parsed.enrichment?.bullet_points ?? [],
        keywords: parsed.enrichment?.keywords ?? [],
        entities: parsed.enrichment?.entities ?? {
          people: [], orgs: [], products: [], tech: [], standards: []
        },
        topics: parsed.enrichment?.topics ?? [],
        links: parsed.enrichment?.links ?? [],
        transcript_used: Boolean(transcript),
        model_used: model,
      };

      state.processed.push(item.id);
      await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
      await saveJsonCheckpoint(STATE_FILE, state);

      // Unified usage logging (real counts if available, else estimate)
      await logStageUsage("enrich", model, prompt, text, item.id, rawUsage);

      processedCount++;
      log("Enriched item", { id: item.id, model, yt: Boolean(videoId) });
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
