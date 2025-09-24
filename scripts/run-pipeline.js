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
const ROOT = path.resolve(__dirname, "..");
const CACHE = path.join(ROOT, "data", "cache");
const STATE_FILE = path.join(CACHE, "pipeline-state.json");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); }
  catch { return { completed: [] }; }
}
async function saveState(s) {
  await ensureDir(CACHE);
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

export async function runPipeline() {
  const steps = [
    { name: "Ingest", fn: ingest },
    { name: "Enrich", fn: enrich },
    { name: "Classify", fn: classify },
    { name: "Digest", fn: digest },
    { name: "Publish", fn: publish }
  ];

  const state = await loadState();

  for (const step of steps) {
    if (state.completed.includes(step.name)) {
      log(`⏩ Skipping ${step.name} (already completed)`);
      continue;
    }
    log(`▶ Starting ${step.name}`);
    try {
      await step.fn();
      state.completed.push(step.name);
      log(`✅ Completed ${step.name}`);
    } catch (err) {
      console.error(`❌ ${step.name} failed`, { error: err?.message });
      await saveState(state);
      await buildSystemStatus();
      throw err;
    }
    await saveState(state);
    await buildSystemStatus();
  }

  log("🎉 Pipeline finished successfully");
  await saveState({ completed: [] }); // reset after a full pass
  await buildSystemStatus();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((e) => {
    console.error("Pipeline failed", e);
    process.exitCode = 1;
  });
}

