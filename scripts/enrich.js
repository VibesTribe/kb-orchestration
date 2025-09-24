// scripts/enrich.js
// Incremental enrichment of items using OpenRouter.
// Each enrichment is pushed upstream immediately.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./lib/openrouter.js";
import { pushUpdate } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "enrich-state.json");

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function idFor(item) {
  return item.id ?? item.canonicalId ?? item.url;
}

function buildMessages(item) {
  return [
    { role: "system", content: "Summarize into a short summary and a longer description." },
    { role: "user", content: `Title: ${item.title}\nURL: ${item.url}` }
  ];
}

export async function enrich() {
  const knowledge = await fetch("https://raw.githubusercontent.com/VibesTribe/knowledgebase/main/knowledge.json")
    .then(r => r.json())
    .catch(() => ({ items: [] }));

  const state = await loadJson(STATE_FILE, { enriched: [] });
  let updated = 0;

  for (const item of knowledge.items ?? []) {
    const id = idFor(item);
    if (!id || state.enriched.includes(id)) continue;
    if (item.summary && item.description) {
      state.enriched.push(id);
      continue;
    }

    try {
      const { content } = await callOpenRouter(buildMessages(item), { maxTokens: 400 });
      const [summary, description] = content.split("\n").map(s => s.trim());
      item.summary = summary || item.summary;
      item.description = description || item.description;

      state.enriched.push(id);
      updated++;

      await saveJson(STATE_FILE, state);
      await pushUpdate(knowledge, `Enrich item ${id}`);
      console.log("Enriched", { id, title: item.title });
    } catch (e) {
      console.error("Failed enrichment", { id, error: e.message });
      await saveJson(STATE_FILE, state);
      throw e;
    }
  }
  return { count: updated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch(e => { console.error(e); process.exitCode = 1; });
}
