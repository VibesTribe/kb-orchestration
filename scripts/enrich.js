// scripts/enrich.js
// Enrichment flow focused on high-quality, classification-ready outputs.
// Provider priority per item: Gemini (direct) → OpenAI (direct) → OpenRouter (guardrailed) → DeepSeek (guardrailed).
// YouTube: transcript → rich JSON (fullSummary + summary + enrichment).
// Saves incrementally after each item. Fail-fast after N consecutive full failures.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

import { callWithRotation } from "./lib/openrouter.js";
import { callGemini } from "./lib/gemini.js";
import { callOpenAI } from "./lib/openai.js";
import { callDeepSeek } from "./lib/deepseek.js";
import { safeCall } from "./lib/guardrails.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage } from "./lib/token-usage.js";
import { syncKnowledge } from "./lib/kb-sync.js";   // ✅ NEW

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

// … [all helper functions unchanged] …

// ---------- Main enrichment ----------
export async function enrich(options = {}) {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  const maxConsecutiveFails = Number(options?.failFast?.maxConsecutiveFails ?? 5);
  let consecutiveFails = 0;
  let processedCount = 0;

  for (const item of knowledge.items) {
    if (state.processed.includes(item.id)) continue;

    let fullyFailed = false;

    try {
      // … [transcript + prompt building unchanged] …

      // Priority chain: Gemini → OpenAI → OpenRouter → DeepSeek
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
        // … [fallbacks unchanged] …
      }

      const parsed = parseStrictJSON(text);

      const fullSummary =
        parsed?.full_summary ??
        parsed?.fullSummary ??
        parsed?.summary ?? "";
      const shortSummary =
        parsed?.summary ??
        parsed?.short_summary ??
        parsed?.shortSummary ??
        parsed?.blurb ?? "";

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
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
        await saveJsonCheckpoint(STATE_FILE, state);

        await syncKnowledge();   // ✅ NEW → push immediately

        await logStageUsage("enrich", model, prompt, text, item.id, rawUsage);

        processedCount++;
        consecutiveFails = 0;
        log("Enriched item", { id: item.id, model, yt: Boolean(videoId) });

        await sleep(5000);   // ✅ NEW → throttle (~12/min)
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
      const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
      await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
      await saveJsonCheckpoint(STATE_FILE, await loadJson(STATE_FILE, { processed: [] }));
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
