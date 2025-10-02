// scripts/enrich.js
// Enrichment flow focused on high-quality, classification-ready outputs.
// Provider priority per item: Gemini (direct) → OpenRouter (guardrailed) → DeepSeek (guardrailed).
// YouTube: transcript → rich JSON (fullSummary + summary + enrichment).
// Saves incrementally after each item. Fail-fast after N consecutive full failures.
// Idempotent: if knowledge.json already has good enrichment, skip even if cache is empty.
// Transcript handling:
//   - Cache transcripts under data/transcripts/<videoId>.txt
//   - If file has text → reuse (no re-fetch)
//   - If file is empty → treat as "no transcript available" marker; do not re-fetch
//   - Only include transcript in prompt if it has non-empty text
//   - Push transcript files to KB repo via pushUpdate()

import path from "node:path";
import { fileURLToPath } from "node:url";

import { callWithRotation } from "./lib/openrouter.js";
import { callGemini } from "./lib/gemini.js";
// import { callOpenAI } from "./lib/openai.js"; // ⛔ disabled
import { callDeepSeek } from "./lib/deepseek.js";
import { safeCall } from "./lib/guardrails.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage, estimateTokensFromText } from "./lib/token-usage.js";
import { syncKnowledge } from "./lib/kb-sync.js";
import { extractYouTubeVideoId, ensureTranscript } from "./lib/youtube-transcripts.js";

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

  if (transcript && transcript.trim().length > 0) {
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
      // Resolve (and cache) transcript if this is a YouTube video
      const videoId = extractYouTubeVideoId(item);
      let transcript = null;

      if (videoId) {
        try {
          const result = await ensureTranscript(videoId);
          if (result.emptyMarker) {
            const msg = result.updated
              ? "No transcript available; wrote empty marker"
              : "Transcript marker found (none available)";
            log(msg, { id: item.id, videoId });
            transcript = null;
          } else if (result.text) {
            log(result.updated ? "Fetched and cached transcript" : "Using cached transcript", {
              id: item.id,
              videoId,
            });
            transcript = result.text;
          } else {
            log("Transcript step completed without text", { id: item.id, videoId, status: result.status });
            transcript = null;
          }
        } catch (e) {
          // Do not fail enrichment if transcript retrieval fails; just proceed without transcript
          log("Transcript step failed; proceeding without transcript", { id: item.id, error: e.message });
          transcript = null;
        }
      }

      const prompt = buildPromptJSON({ item, transcript });

      // Priority chain: Gemini → OpenRouter (guardrailed) → DeepSeek (guardrailed)
      let text = "";
      let model = "";
      let provider = ""; // <-- NEW: capture provider explicitly
      let rawUsage = null;

      try {
        const r = await callGemini(prompt);
        text = r.text;
        model = r.model;
        provider = "gemini";
        rawUsage = { total_tokens: r.tokens ?? 0, provider };
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
          provider = r.provider || "openrouter";
          rawUsage = { ...r.rawUsage, provider };
          log("Used OpenRouter for enrichment", { id: item.id, model, provider });
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
          provider = "deepseek";
          rawUsage = r.rawUsage ? { ...r.rawUsage, provider } : { provider };
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
        // Persist enrichment back onto item
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
          transcript_used: Boolean(transcript && transcript.trim().length > 0),
          model_used: model
        };

        // --- NEW: per-item token usage in knowledge.json
        const inputTokens = rawUsage?.prompt_tokens ?? estimateTokensFromText(prompt);
        const outputTokens = rawUsage?.completion_tokens ?? estimateTokensFromText(text);
        const totalTokens = rawUsage?.total_tokens ?? (inputTokens + outputTokens);

        item.usage = item.usage || {};
        item.usage.enrich = {
          model,
          provider,
          inputTokens,
          outputTokens,
          totalTokens,
          ts: new Date().toISOString()
        };

        // NOTE: we intentionally do NOT store transcript text in knowledge.json to keep it slim.
        // The transcript (if any) is persisted as a file under data/transcripts and pushed to KB.

        state.processed.push(item.id);
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);  // never truncates; updates existing
        await saveJsonCheckpoint(STATE_FILE, state);

        await syncKnowledge(); // push knowledge.json & state changes
        await logStageUsage("enrich", model, prompt, text, item.id, { ...rawUsage, provider });

        processedCount++;
        consecutiveFails = 0;
        log("Enriched item", {
          id: item.id,
          model,
          provider,
          yt: Boolean(videoId),
          transcript_used: Boolean(transcript && transcript.trim().length > 0),
          tokens: totalTokens
        });

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
      // Persist current files as-is (no truncation)
      await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
      await saveJsonCheckpoint(STATE_FILE, state);
    }
  }

  log("Enrich step complete", {
    total: knowledge.items.length,
    processed: processedCount
  });
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

// ---------- Entrypoint ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich step failed", err);
    process.exitCode = 1;
  });
}
