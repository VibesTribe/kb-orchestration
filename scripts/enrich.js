import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callWithRotation } from "./lib/openrouter.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT, "data", "knowledge.json");
const STATE_FILE = path.join(ROOT, "data/cache/enrich-state.json");

function log(msg, ctx = {}) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ctx);
}

export async function enrich() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  let processedCount = 0;

  for (const item of knowledge.items) {
    if (state.processed.includes(item.id)) continue;

    try {
      const { text, model } = await callWithRotation(
        `Summarize this item:\n\nTitle: ${item.title}\nURL: ${item.url}\n\nDescription: ${item.description ?? ""}`,
        "enrich"
      );

      item.summary = text;
      item.modelUsed = model;

      state.processed.push(item.id);
      await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
      await saveJsonCheckpoint(STATE_FILE, state);

      log("Enriched item", { id: item.id, model });
      processedCount++;
    } catch (err) {
      log("Failed to enrich item", { id: item.id, error: err.message });
    }
  }

  log("Enrich step complete", { total: knowledge.items.length, processed: processedCount });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch(err => {
    console.error("Enrich step failed", err);
    process.exitCode = 1;
  });
}
