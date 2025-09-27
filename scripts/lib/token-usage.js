// scripts/lib/token-usage.js
// Central logger for token usage across stages (per run, per model, per item)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const STATE_FILE = path.join(ROOT, "data/cache/pipeline-usage.json");

async function loadUsage() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { runs: [] };
  }
}

async function saveUsage(data) {
  await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), "utf8");
}

/** Rough token estimator (≈ 4 chars/token) */
export function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Log usage for a single item or stage
 * @param {Object} params
 * @param {string} params.stage - "enrich" | "classify"
 * @param {string} params.model - model name
 * @param {number} params.inputTokens
 * @param {number} params.outputTokens
 * @param {string} [params.itemId]
 */
export async function logUsage({ stage, model, inputTokens = 0, outputTokens = 0, itemId }) {
  const state = await loadUsage();
  const day = new Date().toISOString().slice(0, 10);

  let run = state.runs[state.runs.length - 1];
  if (!run || run.day !== day) {
    run = { id: new Date().toISOString(), day, stages: {}, items: [] };
    state.runs.push(run);
  }

  if (!run.stages[stage]) run.stages[stage] = {};
  if (!run.stages[stage][model]) run.stages[stage][model] = { input: 0, output: 0, total: 0 };

  run.stages[stage][model].input += inputTokens;
  run.stages[stage][model].output += outputTokens;
  run.stages[stage][model].total += inputTokens + outputTokens;

  if (itemId) {
    run.items.push({
      id: itemId,
      stage,
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    });
  }

  await saveUsage(state);
}
