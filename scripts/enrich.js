import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./lib/openrouter.js";

/* ------------------ Paths & constants ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "enrich-state.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

// Optional cap so a single run doesn't blow through tokens
const MAX_ITEMS_PER_RUN =
  Number.parseInt(process.env.ENRICH_MAX_ITEMS ?? "", 10) || 25;

/* ------------------ Small utils ------------------ */
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
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

async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${payload}`);
}

/* ------------------ Curated run helpers ------------------ */
async function getLatestCuratedRun() {
  const dayDirs = await listDirectories(CURATED_ROOT);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();

  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(CURATED_ROOT, dayDir));
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(CURATED_ROOT, dayDir, stampDir, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content) return { dayDir, stampDir, itemsPath, content };
    }
  }
  return null;
}

/**
 * If there is no curated run yet but knowledge.json exists,
 * bootstrap a curated run from knowledge.json so downstream steps
 * (classify/digest/publish) see a consistent structure.
 */
async function ensureCuratedRunFromKnowledge() {
  const existing = await getLatestCuratedRun();
  if (existing) return existing;

  const kb = await loadJson(KNOWLEDGE_FILE, null);
  if (!kb || !Array.isArray(kb.items) || kb.items.length === 0) return null;

  const dayDir = new Date().toISOString().slice(0, 10);
  const stampDir = `bootstrap-${Date.now()}`;
  const itemsPath = path.join(CURATED_ROOT, dayDir, stampDir, "items.json");

  await saveJson(itemsPath, {
    generatedAt: new Date().toISOString(),
    items: kb.items,
  });

  log("Bootstrapped curated run from knowledge.json", {
    dayDir,
    stampDir,
    count: kb.items.length,
  });

  return { dayDir, stampDir, itemsPath, content: { generatedAt: new Date().toISOString(), items: kb.items } };
}

/* ------------------ State ------------------ */
async function loadState() {
  return loadJson(STATE_FILE, { enrichedIds: [] });
}
async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

/* ------------------ OpenRouter prompt ------------------ */
function buildMessagesFor(item) {
  const title = item.title ?? "(untitled)";
  const url = item.url ?? "";
  const hint =
    "Produce a crisp 2–4 sentence **summary** and a one-sentence **why it matters** for execution-minded builders.";

  const system = [
    "You are an expert technical editor.",
    "Write concise, non-fluffy, accurate summaries for a daily engineering digest.",
    "Output STRICT JSON with keys: summary, description.",
    "description should read like 'Why it matters: ...' (one sentence).",
  ].join(" ");

  const user = [
    `Title: ${title}`,
    url ? `URL: ${url}` : "",
    item.description ? `Notes: ${item.description}` : "",
    item.summary ? `Existing summary (revise if needed): ${item.summary}` : "",
    "",
    hint,
    "",
    "Return JSON ONLY, e.g.:",
    `{"summary":"...","description":"Why it matters: ..."}`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseStrictJson(text) {
  // Try to extract the first {...} block and parse it
  const m = text.match(/\{[\s\S]*\}/);
  const raw = m ? m[0] : text;
  const obj = JSON.parse(raw);
  if (typeof obj.summary !== "string" || typeof obj.description !== "string") {
    throw new Error("Missing keys in JSON (summary, description)");
  }
  return obj;
}

/* ------------------ Main enrich ------------------ */
export async function enrich() {
  // Ensure we have a curated run to work on
  let curatedRun = await getLatestCuratedRun();
  if (!curatedRun) {
    curatedRun = await ensureCuratedRunFromKnowledge();
  }
  if (!curatedRun) {
    log("No curated data found; skip enrich");
    return;
  }

  const state = await loadState();
  const items = Array.isArray(curatedRun.content.items)
    ? curatedRun.content.items
    : [];

  // Select items that still need enrichment
  const pending = items.filter((it) => {
    const id = it.canonicalId ?? it.id;
    if (!id) return false;
    if (state.enrichedIds.includes(id)) return false;
    // Needs work if no summary/description yet
    const needs = !(it.summary && it.description);
    return needs;
  });

  if (!pending.length) {
    log("No items needed enrichment");
    return;
  }

  const limit = Math.min(MAX_ITEMS_PER_RUN, pending.length);
  let processed = 0;

  log("Starting enrichment", { toProcess: limit, totalPending: pending.length });

  for (const item of pending.slice(0, limit)) {
    const id = item.canonicalId ?? item.id;

    try {
      const messages = buildMessagesFor(item);
      const { content, model } = await callOpenRouter(messages, {
        temperature: 0.2,
        maxTokens: 300,
      });

      const { summary, description } = parseStrictJson(content);

      // Update item
      item.summary = summary;
      item.description = description;

      // Persist immediately (incremental safety)
      await saveJson(curatedRun.itemsPath, curatedRun.content);

      // Track state and persist
      state.enrichedIds.push(id);
      await saveState(state);

      processed += 1;
      log("Enriched", { id, model });
    } catch (err) {
      // Log but continue; we'll retry this id on the next run
      log("Enrich failed for item; will retry later", {
        id,
        error: err.message,
      });
    }
  }

  log("Enrich complete", { processed, cappedBy: MAX_ITEMS_PER_RUN });

  // Also mirror back to knowledge.json so the site JSON reflects progress if needed
  try {
    const kb = await loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });
    const byId = new Map(kb.items.map((i) => [i.canonicalId ?? i.id, i]));
    for (const it of curatedRun.content.items) {
      const key = it.canonicalId ?? it.id;
      const existing = byId.get(key);
      if (existing) {
        existing.summary = it.summary ?? existing.summary;
        existing.description = it.description ?? existing.description;
      } else {
        // If knowledge.json didn't have it yet, add it
        byId.set(key, it);
      }
    }
    const merged = Array.from(byId.values());
    await saveJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: merged });
  } catch (err) {
    // Non-fatal; publish step will still read from curated
    log("Failed to mirror enrich results to knowledge.json (non-fatal)", { error: err.message });
  }
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich failed", err);
    process.exitCode = 1;
  });
}
