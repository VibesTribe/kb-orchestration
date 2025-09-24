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

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "pipeline-state.json");

/* ------------------ Helpers ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { completed: [] };
  }
}
async function saveState(state) {
  await ensureDir(CACHE_ROOT);
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
function logStep(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

/* ------------------ Pipeline ------------------ */
export async function runPipeline() {
  const steps = [
    { name: "Ingest", fn: ingest },
    { name: "Enrich", fn: enrich },
    { name: "Classify", fn: classify },
    { name: "Digest", fn: digest },
    { name: "Publish", fn: publish },
  ];

  const state = await loadState();

  for (const step of steps) {
    if (state.completed.includes(step.name)) {
      logStep(`⏩ Skipping ${step.name} (already completed)`);
      continue;
    }

    logStep(`▶ Starting ${step.name}`);
    try {
      await step.fn();
      logStep(`✅ Completed ${step.name}`);
      state.completed.push(step.name);
    } catch (error) {
      // ⚠️ Fail-safe: log error but allow pipeline to continue to next steps
      console.error(`❌ ${step.name} failed`, { error: error.message });
    }

    // always save + update status, even if a step failed
    await saveState(state);
    await buildSystemStatus();
  }

  logStep("🎉 Pipeline run finished");
  // reset for next run
  await saveState({ completed: [] });
  await buildSystemStatus();
}

/* ------------------ Run if invoked directly ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((error) => {
    console.error("Pipeline failed unexpectedly", error);
    process.exitCode = 1;
  });
}
