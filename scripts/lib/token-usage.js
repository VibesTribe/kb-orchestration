// scripts/lib/token-usage.js
// Centralized token usage logging with fallback to estimation.

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "data/cache");
const USAGE_FILE = path.join(ROOT, "pipeline-usage.json");

// --- Util: naive token estimator ---
export function estimateTokensFromText(text = "") {
  if (!text) return 0;
  // Roughly 4 chars per token on average
  return Math.ceil(text.length / 4);
}

/**
 * Append usage stats for a single item + stage.
 * @param {Object} params
 * @param {"enrich"|"classify"} params.stage
 * @param {string} params.model
 * @param {string} params.itemId
 * @param {number} [params.inputTokens]
 * @param {number} [params.outputTokens]
 * @param {Object} [params.rawUsage] - Optional raw usage object from API
 */
export async function logUsage({
  stage,
  model,
  itemId,
  inputTokens,
  outputTokens,
  rawUsage = {}
}) {
  await fs.mkdir(ROOT, { recursive: true });

  let log;
  try {
    log = JSON.parse(await fs.readFile(USAGE_FILE, "utf8"));
  } catch {
    log = { runs: [] };
  }

  if (!log.runs.length) {
    log.runs.push({ ts: new Date().toISOString(), stages: {} });
  }
  const run = log.runs[log.runs.length - 1];

  if (!run.stages[stage]) run.stages[stage] = {};
  if (!run.stages[stage][model]) {
    run.stages[stage][model] = { total: 0, details: [] };
  }

  // Prefer raw API counts, fall back to provided, then estimates
  const inTok =
    rawUsage.prompt_tokens ??
    inputTokens ??
    estimateTokensFromText("");
  const outTok =
    rawUsage.completion_tokens ??
    outputTokens ??
    estimateTokensFromText("");
  const total = rawUsage.total_tokens ?? inTok + outTok;

  run.stages[stage][model].total += total;
  run.stages[stage][model].details.push({
    itemId,
    input: inTok,
    output: outTok,
    total,
    ts: new Date().toISOString(),
  });

  await fs.writeFile(USAGE_FILE, JSON.stringify(log, null, 2), "utf8");
}
