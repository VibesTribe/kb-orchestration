// scripts/ingest.js
// Ingests new bookmarks/videos/etc. into data/knowledge.json incrementally.

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

export async function ingest() {
  log("Starting ingest...");

  // Load or initialize knowledge.json
  let knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items)) knowledge.items = [];

  // Fake demo ingestion for now
  // In real use, you’d loop over sources.json and collect new items
  const newItem = {
    id: Date.now().toString(),
    title: "Demo item",
    url: "https://example.com",
    sourceType: "demo",
    ingestedAt: new Date().toISOString(),
  };

  // Deduplicate by ID
  const exists = knowledge.items.find((it) => it.id === newItem.id);
  if (!exists) {
    knowledge.items.push(newItem);

    // Save locally
    await ensureDir(path.dirname(KNOWLEDGE_FILE));
    await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);

    // Push upstream immediately
    await pushUpdate(KNOWLEDGE_FILE, "knowledge.json", "Ingest new item");

    log("Ingested new item", { id: newItem.id });
  } else {
    log("Item already exists, skipping", { id: newItem.id });
  }

  log("Ingest step complete", { total: knowledge.items.length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest step failed", err);
    process.exit(1);
  });
}
