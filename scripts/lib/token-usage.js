// scripts/lib/token-usage.js
// Track and log token usage by stage/model/item into data/cache/pipeline-usage.json

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const USAGE_FILE = path.join(ROOT, "data/cache/pipeline-usage.json");

function nowIso() {
  return new Date().toISOString();
}

/**
 * Rough token estimator based on word/character count.
 * This is used if an API doesn’t return usage stats.
 */
export function estimateTokensFromText(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  const chars = text.length;
  return Math.max(Math.round(words / 0.75), Math.round(chars / 4));
}

/**
 * Log raw usage stats.
 * stage: e.g. "enrich", "classify"
 * model: model name/id
 * inputTokens / outputTokens: numbers
 * itemId: knowledge item id
 */
export async function logUsage({ stage, model, inputTokens = 0, outputTokens = 0, itemId }) {
  let usage = { runs: [] };
  try {
    usage = JSON.parse(await fs.readFile(USAGE_FILE, "utf8"));
  } catch {
    // first run
  }

  if (!usage.runs.length || usage.runs[usage.runs.length - 1].finished) {
    usage.runs.push({
      started: nowIso(),
      stages: {},
      finished: false,
    });
  }

  const run = usage.runs[usage.runs.length - 1];
  if (!run.stages[stage]) run.stages[stage] = {};
  if (!run.stages[stage][model]) {
    run.stages[stage][model] = { total: 0, items: [] };
  }

  const record = run.stages[stage][model];
  const total = inputTokens + outputTokens;
  record.total += total;
  record.items.push({
    itemId,
    input: inputTokens,
    output: outputTokens,
    total,
    ts: nowIso(),
  });

  await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
  await fs.writeFile(USAGE_FILE, JSON.stringify(usage, null, 2), "utf8");
}

/**
 * Convenience helper: logs usage with token estimates if API didn’t provide them.
 * @param {string} stage - e.g. "enrich" or "classify"
 * @param {string} model - model name/id
 * @param {string} prompt - input text
 * @param {string} output - output text
 * @param {string} itemId - knowledge item ID
 * @param {object} [usage] - optional { prompt_tokens, completion_tokens }
 */
export async function logStageUsage(stage, model, prompt, output, itemId, usage = {}) {
  const inTok = usage.prompt_tokens ?? estimateTokensFromText(prompt);
  const outTok = usage.completion_tokens ?? estimateTokensFromText(output);
  await logUsage({
    stage,
    model,
    inputTokens: inTok,
    outputTokens: outTok,
    itemId,
  });
}

/**
 * Mark the current run as finished (optional, called at end of pipeline)
 */
export async function finishUsageRun() {
  let usage = { runs: [] };
  try {
    usage = JSON.parse(await fs.readFile(USAGE_FILE, "utf8"));
  } catch {
    return;
  }
  if (!usage.runs.length) return;
  const run = usage.runs[usage.runs.length - 1];
  run.finished = true;
  run.ended = nowIso();
  await fs.writeFile(USAGE_FILE, JSON.stringify(usage, null, 2), "utf8");
}
