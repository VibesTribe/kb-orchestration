import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "ingest-state.json");
const SOURCES_FILE = path.join(ROOT_DIR, "sources.json");
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

/* ------------------ Source loading ------------------ */
async function loadSources() {
  return loadJson(SOURCES_FILE, { raindrop: {}, youtube: {}, rss: [] });
}

async function loadState() {
  return loadJson(STATE_FILE, { completedOnce: {} });
}

async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

async function loadKnowledge() {
  return loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });
}

async function saveKnowledge(kb) {
  kb.generatedAt = new Date().toISOString();
  await saveJson(KNOWLEDGE_FILE, kb);
}

/* ------------------ Normalization ------------------ */
function normalizeCollection(collection) {
  if (!collection || collection === "0" || /^\d+$/.test(collection)) return "misc";
  return collection.toLowerCase();
}

/* ------------------ Fake fetchers (stub) ------------------ */
// TODO: replace with real Raindrop, YouTube, RSS fetch logic
async function fetchRaindropItems(collectionId, window) {
  return [
    {
      id: `rd-${collectionId}-${Date.now()}`,
      title: "Demo Raindrop Bookmark",
      url: "https://example.com/bookmark",
      sourceType: "raindrop",
      co
