// scripts/enrich.js
// Enrichment flow focused on high-quality, classification-ready outputs.
// Provider priority per item: Gemini (direct) → OpenRouter (guardrailed) → DeepSeek (guardrailed).
// YouTube: transcript → rich JSON (fullSummary + summary + enrichment).
// Saves incrementally after each item. Fail-fast after N consecutive full failures.
// Idempotent: if knowledge.json already has good enrichment, skip even if cache is empty.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

import { callWithRotation } from "./lib/openrouter.js";
import { callGemini } from "./lib/gemini.js";
// import { callOpenAI } from "./lib/openai.js"; // ⛔ disabled
import { callDeepSeek } from "./lib/deepseek.js";
import { safeCall } from "./lib/guardrails.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage } from "./lib/token-usage.js";
import { syncKnowledge } from "./lib/kb-sync.js";

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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractYouTubeVideoId(item) {
  try {
    if (typeof item.id === "string" && item.id.startsWith("youtube:video:")) {
      return item.id.split(":").pop();
    }
    if (!item.url) return null;
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

  // JSON3 first
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

  // Fallback to VTT
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
    "You are an expert analyst enriching items for a knowledgebase.",
    "Return STRICT JSON ONLY (no Markdown), matching exactly this schema:",
`{
  "full_summary": "250-400 word neutral, specific summary capturing main ideas, methods, results, caveats, with concrete details.",
  "summary": "2-3 sentence concise blurb for a daily digest (40-80 words).",
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

function looksBad(txt = "") {
  const s = String(txt).toLowerCase();
  if (s.length < 80) return true;
  const bad = ["please provide", "i cannot", "insufficient information", "as an ai", "cannot summarize", "need more information"];
  return bad.some((p) => s.includes(p));
}

// Strict JSON extractor (grabs first {...} block)
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
export async function enrich(options = {}) {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  const maxConsecutiveFails = Number(options?.failFast?.maxConsecutiveFails ?? 5);
  let consecutiveFails = 0;
  let processedCount = 0;

  for (const item of knowledge.items) {
    // Knowledge-first idempotent skip
    const alreadyEnriched =
      item?.fullSummary &&
      item?.summary &&
      item?.enrichment &&
      !looksBad(item.fullSummary);

    if (alreadyEnriched || state.processed.includes(item.id)) {
      if (!state.processed.includes(item.id)) {
        state.processed.push(item.id);
        await saveJsonCheckpoint(STATE_FILE, state);
      }
      continue;
    }

    let fullyFailed = false;

    try {
      const videoId = extractYouTubeVideoId(item);
      let transcript = null;
      if (videoId) {
        try {
          transcript = await fetchTranscriptTimedText(videoId);
          if (transcript) item.transcript = clamp(transcript);
        } catch (e) {
          log("Transcript fetch failed", { id: item.id, error: e.message });
        }
      }

      const prompt = buildPromptJSON({ item, transcript });

      // Priority chain: Gemini → OpenRouter (guardrailed) → DeepSeek (guardrailed)
      let text = "";
      let model = "";
      let rawUsage = null;

      try {
        const r = await callGemini(prompt);
        text = r.text;
        model = r.model;
        rawUsage = { total_tokens: r.tokens ?? 0, provider: "gemini" };
        log("Used Gemini for enrichment", { id: item.id, model });
      } catch (e1) {
        log("Gemini failed; fallback to OpenRouter", { id: item.id, error: e1.message });
        try {
          const r = await safeCall({
            provider: "openrouter",
            model: "rotation",
            fn: () => callWithRotation(prompt, "enrich"),
            estCost: 1
          });
          if (!r) throw new Error("OpenRouter skipped (cap reached)");
          text = r.text;
          model = r.model;
          rawUsage = { ...r.rawUsage, provider: r.provider || "openrouter" };
          log("Used OpenRouter for enrichment", { id: item.id, model, provider: r.provider });
        } catch (e3) {
          log("OpenRouter failed; fallback to DeepSeek", { id: item.id, error: e3.message });
          const r = await safeCall({
            provider: "deepseek",
            model: "deepseek-chat",
            fn: () => callDeepSeek(prompt),
            estCost: 0.01
          });
          if (!r) throw new Error("DeepSeek skipped (cap reached)");
          text = r.text;
          model = r.model;
          rawUsage = r.rawUsage ?? null;
          log("Used DeepSeek direct for enrichment", { id: item.id, model });
        }
      }

      const parsed = parseStrictJSON(text);

      const fullSummary =
        parsed?.full_summary ??
        parsed?.fullSummary ??
        parsed?.summary ??
        "";
      const shortSummary =
        parsed?.summary ??
        parsed?.short_summary ??
        parsed?.shortSummary ??
        parsed?.blurb ??
        "";

      if (!fullSummary || looksBad(fullSummary)) {
        log("Invalid enrichment output (fullSummary)", { id: item.id, model });
        fullyFailed = true;
      } else {
        item.fullSummary = fullSummary;
        if (shortSummary && !looksBad(shortSummary)) {
          item.summary = shortSummary;
        } else {
          const s = fullSummary.replace(/\s+/g, " ").trim();
          item.summary = s.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
        }

        item.enrichment = {
          bullet_points: parsed?.enrichment?.bullet_points ?? [],
          keywords: parsed?.enrichment?.keywords ?? [],
          entities: parsed?.enrichment?.entities ?? {
            people: [], orgs: [], products: [], tech: [], standards: []
          },
          topics: parsed?.enrichment?.topics ?? [],
          links: parsed?.enrichment?.links ?? [],
          transcript_used: Boolean(transcript),
          model_used: model
        };

        state.processed.push(item.id);
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);  // never truncates; updates existing
        await saveJsonCheckpoint(STATE_FILE, state);

        await syncKnowledge(); // push immediately
        await logStageUsage("enrich", model, prompt, text, item.id, rawUsage);

        processedCount++;
        consecutiveFails = 0;
        log("Enriched item", { id: item.id, model, yt: Boolean(videoId) });

        await sleep(5000); // throttle
      }
    } catch (err) {
      fullyFailed = true;
      log("Failed to enrich item", { id: item.id, error: err.message });
    }

    if (fullyFailed) {
      consecutiveFails += 1;
      if (consecutiveFails >= maxConsecutiveFails) {
        throw new Error(
          `Fail-fast: ${consecutiveFails} consecutive items failed to enrich across all providers`
        );
      }
      // No truncation here; just persist current files as-is
      await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
      await saveJsonCheckpoint(STATE_FILE, state);
    }
  }

  log("Enrich step complete", {
    total: knowledge.items.length,
    processed: processedCount
  });
}

// ---------- Entrypoint ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich step failed", err);
    process.exitCode = 1;
  });
}
