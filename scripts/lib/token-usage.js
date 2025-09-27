// scripts/lib/token-usage.js
// Tracks per-model token usage across pipeline stages.
// Saves incrementally to data/cache/pipeline-usage.json

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const USAGE_FILE = path.join(ROOT_DIR, "data", "cache", "pipeline-usage.json");

/**
 * Load usage file (safe fallback).
 */
async function loadUsage() {
  try {
    const text = await fs.readFile(USAGE_FILE, "utf8");
    return JSON.parse(text);
  } catch {
    return { runs: [] };
  }
}

/**
 * Save usage file safely.
 */
async function saveUsage(data) {
  await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
  await fs.writeFile(USAGE_FILE, JSON.stringify(data, null, 2));
}

/**
 * Start a new run entry (called once at pipeline start).
 */
export async function startUsageRun() {
  const usage = await loadUsage();
  const run = {
    startedAt: new Date().toISOString(),
    stages: {}, // e.g. { enrich: { "openai/gpt-4.0-mini": { total: 1234 } } }
  };
  usage.runs.push(run);
  await saveUsage(usage);
}

/**
 * Record a token usage increment.
 * @param {string} stage - e.g. "enrich", "classify"
 * @param {string} model - e.g. "openai/gpt-4.0-mini"
 * @param {number} tokens - number of tokens consumed
 */
export async function recordUsage(stage, model, tokens) {
  if (!tokens || !Number.isFinite(tokens)) return;

  const usage = await loadUsage();
  if (!usage.runs.length) {
    usage.runs.push({ startedAt: new Date().toISOString(), stages: {} });
  }
  const run = usage.runs[usage.runs.length - 1];

  if (!run.stages[stage]) run.stages[stage] = {};
  if (!run.stages[stage][model]) run.stages[stage][model] = { total: 0 };

  run.stages[stage][model].total += tokens;
  run.updatedAt = new Date().toISOString();

  await saveUsage(usage);
}

/**
 * Get the latest run (for reporting in digest).
 */
export async function getLatestUsageRun() {
  const usage = await loadUsage();
  return usage.runs[usage.runs.length - 1] || null;
}
