import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "enrich-state.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

/* ------------------ Helpers ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

/* ------------------ Enrichment stub ------------------ */
// TODO: Replace this with real LLM enrichment (OpenRouter API etc.)
async function generateSummary(item) {
  return {
    summary: `This is a placeholder summary for "${item.title}".`,
    description: `Detailed description for ${item.url}.`
  };
}

/* ------------------ State ------------------ */
async function loadState() {
  return loadJson(STATE_FILE, { enrichedIds: [] });
}

async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

/* ------------------ Main ------------------ */
export async function enrich() {
  const kb = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadState();

  let updated = 0;

  for (const item of kb.items) {
    if (state.enrichedIds.includes(item.id)) continue;
    if (item.summary && item.description) continue;

    try {
      const { summary, description } = await generateSummary(item);
      item.summary = summary;
      item.description = description;
      state.enrichedIds.push(item.id);
      updated++;

      // Save incrementally
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveState(state);

      log(`Enriched item ${item.id}`, { title: item.title });
    } catch (err) {
      log(`Failed to enrich item ${item.id}`, { error: err.message });
      // Save partial state so we don’t lose progress
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveState(state);
      throw err; // Let pipeline retry
    }
  }

  if (updated === 0) {
    log("No items needed enrichment");
  } else {
    log(`Enriched ${updated} new items`);
  }
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich failed", err);
    process.exitCode = 1;
  });
}
