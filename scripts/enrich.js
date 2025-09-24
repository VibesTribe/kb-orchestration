// scripts/enrich.js
// Enrich items with summaries/descriptions via LLM (OpenRouter).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJsonCheckpoint, ensureDir } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

// Placeholder: real enrichment would call OpenRouter API
async function generateSummary(item) {
  return {
    summary: `Auto-summary for "${item.title}"`,
    description: item.description || "Generated description.",
  };
}

export async function enrich() {
  log("Starting enrich...");

  let knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items)) knowledge.items = [];

  let processed = 0;

  for (const item of knowledge.items) {
    if (item.summary && item.description) continue;

    const enriched = await generateSummary(item);
    item.summary = enriched.summary;
    item.description = enriched.description;
    item.enrichedAt = new Date().toISOString();

    // Save locally
    await ensureDir(path.dirname(KNOWLEDGE_FILE));
    await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);

    // Push upstream immediately
    await pushUpdate(KNOWLEDGE_FILE, "knowledge.json", `Enrich item ${item.id}`);

    log("Enriched item", { id: item.id });
    processed++;
  }

  log("Enrich step complete", { total: knowledge.items.length, processed });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich step failed", err);
    process.exit(1);
  });
}
