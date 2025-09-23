import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "classify-state.json");
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

/* ------------------ Classification stub ------------------ */
// TODO: Replace with real classifier (LLM / model-based)
async function classifyItem(item) {
  // A fake rule-based classifier just for scaffolding
  if (item.title?.toLowerCase().includes("ai")) {
    return [
      {
        project: "AI Research",
        projectKey: "ai-research",
        usefulness: "high",
        reason: "Mentions AI directly in title/summary."
      }
    ];
  }
  return [
    {
      project: "General",
      projectKey: "general",
      usefulness: "medium",
      reason: "Default bucket for unclassified items."
    }
  ];
}

/* ------------------ State ------------------ */
async function loadState() {
  return loadJson(STATE_FILE, { classifiedIds: [] });
}

async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

/* ------------------ Main ------------------ */
export async function classify() {
  const kb = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadState();

  let updated = 0;

  for (const item of kb.items) {
    if (state.classifiedIds.includes(item.id)) continue;
    if (item.assignedProjects && item.assignedProjects.length > 0) continue;

    try {
      const assignedProjects = await classifyItem(item);
      item.assignedProjects = assignedProjects;
      state.classifiedIds.push(item.id);
      updated++;

      // Save incrementally
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveState(state);

      log(`Classified item ${item.id}`, { title: item.title });
    } catch (err) {
      log(`Failed to classify item ${item.id}`, { error: err.message });
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveState(state);
      throw err;
    }
  }

  if (updated === 0) {
    log("No items needed classification");
  } else {
    log(`Classified ${updated} new items`);
  }
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify failed", err);
    process.exitCode = 1;
  });
}

