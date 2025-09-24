// scripts/enrich.js
// Incremental enrichment of knowledge items using OpenRouter models.
// Loads preferred models from config/models.json, tries them in order,
// logs per-item which model succeeded, saves checkpoints after each step.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJsonCheckpoint, ensureDir } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";
import { callOpenRouter } from "./lib/openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA, "cache");
const ENRICH_STATE_FILE = path.join(CACHE_DIR, "enrich-state.json");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const MODELS_FILE = path.join(ROOT, "config", "models.json");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

async function loadKnowledge() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items)) knowledge.items = [];
  return knowledge;
}

async function saveKnowledge(knowledge) {
  await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
  await pushUpdate(KNOWLEDGE_FILE, "knowledge.json", "Incremental enrich update");
}

async function loadEnrichState() {
  await ensureDir(CACHE_DIR);
  const state = await loadJson(ENRICH_STATE_FILE, { processedIds: [] });
  if (!Array.isArray(state.processedIds)) state.processedIds = [];
  return state;
}

async function saveEnrichState(state) {
  await saveJsonCheckpoint(ENRICH_STATE_FILE, state);
}

async function loadModelPrefs() {
  const cfg = await loadJson(MODELS_FILE, null);
  if (!cfg || !Array.isArray(cfg.enrich) || cfg.enrich.length === 0) {
    // sensible default if config missing
    return ["openrouter/anthropic-claude-3-sonnet"];
  }
  return cfg.enrich;
}

async function enrichItem(item, models) {
  const prompt = `Summarize the following content in 2–3 sentences. Provide a short description too.\n\nTitle: ${item.title}\nURL: ${item.url || "N/A"}`;
  for (const model of models) {
    try {
      const result = await callOpenRouter(model, prompt);
      if (!result || !result.text) throw new Error("No text returned");
      item.summary = result.text.trim();
      item.description = item.summary; // can refine later if needed
      item.enrichedAt = new Date().toISOString();
      item.model = model;
      return true;
    } catch (err) {
      log("Model failed", { model, error: err.message });
      continue;
    }
  }
  return false;
}

export async function enrich() {
  log("Starting enrich...");

  const knowledge = await loadKnowledge();
  const state = await loadEnrichState();
  const models = await loadModelPrefs();

  let processed = 0;
  let skipped = 0;

  for (const item of knowledge.items) {
    if (state.processedIds.includes(item.id)) {
      skipped++;
      continue;
    }
    if (item.summary && item.description) {
      skipped++;
      state.processedIds.push(item.id);
      continue;
    }

    const ok = await enrichItem(item, models);
    if (ok) {
      processed++;
      state.processedIds.push(item.id);
      await saveKnowledge(knowledge); // save after each success
      await saveEnrichState(state);
      log("Enriched item", { id: item.id, model: item.model });
    } else {
      log("Failed to enrich item after all models", { id: item.id });
    }
  }

  log("Enrich step complete", { total: knowledge.items.length, processed, skipped });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich step failed", err);
    process.exit(1);
  });
}
