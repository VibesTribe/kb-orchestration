// scripts/lib/token-usage.js
// Centralized token usage logging with fallback to estimation.
// Produces data/cache/pipeline-usage.json in this shape:
//
// {
//   "runs": [
//     {
//       "ts": "...",
//       "stages": {
//         "enrich": {
//           "<model>": {
//             "total": 1234,
//             "provider": "openrouter",   // optional
//             "details": [ { itemId, input, output, total, ts } ]
//           }
//         },
//         "classify": { ... }
//       }
//     }
//   ]
// }

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "data", "cache");
const USAGE_FILE = path.join(ROOT, "pipeline-usage.json");

// --- Naive estimator (~4 chars per token) ---
export function estimateTokensFromText(text = "") {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// Start a new usage "run" entry (call once per pipeline execution)
export async function startUsageRun() {
  await fs.mkdir(ROOT, { recursive: true });
  let log;
  try {
    log = JSON.parse(await fs.readFile(USAGE_FILE, "utf8"));
  } catch {
    log = { runs: [] };
  }
  log.runs.push({ ts: new Date().toISOString(), stages: {} });
  await fs.writeFile(USAGE_FILE, JSON.stringify(log, null, 2), "utf8");
}

/**
 * Log usage for a stage with best-available accuracy.
 * Prefer real API counts (rawUsage) → else estimate from text.
 *
 * @param {"enrich"|"classify"} stage
 * @param {string} model
 * @param {string} prompt
 * @param {string} completion
 * @param {string} itemId
 * @param {object|null} rawUsage  (optional: {prompt_tokens, completion_tokens, total_tokens, provider?})
 */
export async function logStageUsage(
  stage,
  model,
  prompt,
  completion,
  itemId,
  rawUsage = null
) {
  await fs.mkdir(ROOT, { recursive: true });

  let log;
  try {
    log = JSON.parse(await fs.readFile(USAGE_FILE, "utf8"));
  } catch {
    log = { runs: [] };
  }

  // Ensure there's an active run (pipeline should call startUsageRun(), but guard here too)
  if (!Array.isArray(log.runs) || log.runs.length === 0) {
    log.runs = [{ ts: new Date().toISOString(), stages: {} }];
  }
  const run = log.runs[log.runs.length - 1];

  if (!run.stages[stage]) run.stages[stage] = {};
  if (!run.stages[stage][model]) {
    run.stages[stage][model] = { total: 0, details: [] };
  }

  const inTok = rawUsage?.prompt_tokens ?? estimateTokensFromText(prompt);
  const outTok = rawUsage?.completion_tokens ?? estimateTokensFromText(completion);
  const total = rawUsage?.total_tokens ?? inTok + outTok;

  // Merge provider info if present
  if (rawUsage?.provider) {
    run.stages[stage][model].provider = rawUsage.provider;
  }

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
