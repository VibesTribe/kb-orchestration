// scripts/enrich.js
import { loadJson, saveJsonCheckpoint, ensureDir } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";
import { callOpenRouter } from "./lib/openrouter.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "cache");
const ENRICH_STATE = path.join(CACHE, "enrich-state.json");
const KNOW_FILE = path.join(DATA, "knowledge.json");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, ctx);
}

async function loadKnowledge() {
  const obj = await loadJson(KNOW_FILE, { items: [] });
  if (!Array.isArray(obj.items)) obj.items = [];
  return obj;
}

async function saveKnowledge(knowledge) {
  await ensureDir(path.dirname(KNOW_FILE));
  await saveJsonCheckpoint(KNOW_FILE, knowledge);
  await pushUpdate(KNOW_FILE, "knowledge.json", "Enrich update");
}

async function loadState() {
  await ensureDir(path.dirname(ENRICH_STATE));
  const obj = await loadJson(ENRICH_STATE, { processedIds: [] });
  if (!Array.isArray(obj.processedIds)) obj.processedIds = [];
  return obj;
}

async function saveState(state) {
  await ensureDir(path.dirname(ENRICH_STATE));
  await saveJsonCheckpoint(ENRICH_STATE, state);
}

export async function enrich() {
  log("Starting enrich...");
  const knowledge = await loadKnowledge();
  const state = await loadState();

  let processed = 0;
  let skipped = 0;

  for (const item of knowledge.items) {
    if (state.processedIds.includes(item.id)) {
      skipped++;
      continue;
    }
    if (item.summary && item.description) {
      state.processedIds.push(item.id);
      continue;
    }

    try {
      const { text, model } = await callOpenRouter(
        `Summarize for item: title=${item.title} url=${item.url}`
      );
      item.summary = text.trim();
      item.description = text.trim();
      item.enrichedAt = new Date().toISOString();
      item.model = model;

      processed++;
    } catch (err) {
      log("All models failed to enrich item", { id: item.id, error: err.message });
      // Could optionally still record that as processed, to avoid retry forever
    }

    state.processedIds.push(item.id);

    await saveKnowledge(knowledge);
    await saveState(state);

    log("Enriched item", { id: item.id, model: item.model });
  }

  log("Enrich done", { total: knowledge.items.length, processed, skipped });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("enrich failure", err);
    process.exit(1);
  });
}
