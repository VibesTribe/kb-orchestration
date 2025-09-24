import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./openrouter.js";

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

/* ------------------ Enrichment with OpenRouter ------------------ */
async function generateSummary(item) {
  const messages = [
    {
      role: "system",
      content:
        "You are a precise research summarizer. Write a short summary and a 2–3 sentence description of the provided resource."
    },
    {
      role: "user",
      content: `Title: ${item.title ?? "(untitled)"}\nURL: ${item.url ?? "unknown"}`
    }
  ];

  const { content } = await callOpenRouter(messages, { maxTokens: 250, temperature: 0.2 });

  // Split: first sentence = summary, rest = description
  const [first, ...rest] = content.split(/(?<=\.)\s+/);
  return {
    summary: first?.trim() || `Summary for ${item.title ?? "item"}`,
    description: rest.join(" ").trim() || first?.trim() || ""
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
