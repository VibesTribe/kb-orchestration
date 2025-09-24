import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
import { digest } from "./digest.js";
import { publish } from "./publish.js";
import { buildSystemStatus } from "./system-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "pipeline-state.json");
const STATS_FILE = path.join(CACHE_ROOT, "stats.json");

function logStep(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

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

export async function runPipeline() {
  const steps = [
    { name: "Ingest", fn: ingest },
    { name: "Enrich", fn: enrich },
    { name: "Classify", fn: classify },
    { name: "Digest", fn: digest },
    { name: "Publish", fn: publish }
  ];

  const state = await loadJson(STATE_FILE, { completed: [] });
  const stats = await loadJson(STATS_FILE, {
    ingested: 0,
    enriched: 0,
    classified: 0,
    digests: 0,
    published: 0
  });

  for (const step of steps) {
    if (state.completed.includes(step.name)) {
      logStep(`⏩ Skipping ${step.name} (already completed)`);
      continue;
    }
    logStep(`▶ Starting ${step.name}`);
    try {
      const result = await step.fn(); // each step may return {count}
      if (result && typeof result.count === "number") {
        if (step.name === "Ingest") stats.ingested += result.count;
        if (step.name === "Enrich") stats.enriched += result.count;
        if (step.name === "Classify") stats.classified += result.count;
        if (step.name === "Digest") stats.digests += result.count;
        if (step.name === "Publish") stats.published += result.count;
      }

      logStep(`✅ Completed ${step.name}`);
      state.completed.push(step.name);
      await saveJson(STATE_FILE, state);

      await buildSystemStatus({
        lastRunStep: step.name,
        completedSteps: [...state.completed],
        stats
      });
    } catch (error) {
      console.error(`❌ ${step.name} failed`, { error: error?.message || String(error) });
      await saveJson(STATE_FILE, state);
      await buildSystemStatus({
        lastRunStep: step.name,
        completedSteps: [...state.completed],
        stats
      });
      throw error;
    }
  }

  logStep("🎉 Pipeline finished successfully");
  await saveJson(STATE_FILE, { completed: [] }); // reset for next run
  await buildSystemStatus({
    lastRunStep: "Done",
    completedSteps: [],
    stats
  });
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((error) => {
    console.error("Pipeline failed", error);
    process.exitCode = 1;
  });
}
