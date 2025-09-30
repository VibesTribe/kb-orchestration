// scripts/run-pipeline.js
// Orchestrates the full incremental knowledge pipeline:
// ingest → enrich → classify → digest → publish → sync upstream
//
// Additions:
// - Per-stage fail-fast thresholds (plumbed as options; stages may ignore until updated)
// - Clear, mode-specific logging
// - Force daily mode permanently (no fragile bootstrap cache)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
import { digest } from "./digest.js";
import { publish } from "./publish.js";
import { pullKnowledge, syncKnowledge, syncDigest } from "./lib/kb-sync.js";
import { startUsageRun } from "./lib/token-usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "cache");

// ---- Config (env overrides allowed) ----
const MAX_CONSECUTIVE_FAILS = Number(process.env.MAX_CONSECUTIVE_FAILS ?? 5);

// Helpers
function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

async function run() {
  log("🚀 Starting knowledge pipeline…");

  // NEW: start a fresh token-usage run
  try {
    await startUsageRun();
  } catch (e) {
    log("⚠️ startUsageRun failed; continuing", { error: e?.message });
  }

  // 🔒 Force daily mode (skip fragile bootstrap-state.json)
  const mode = "daily";

  log("🧭 Mode selected", {
    mode,
    maxConsecutiveFails: MAX_CONSECUTIVE_FAILS,
  });

  // Options we pass to stages
  const stageOpts = {
    mode,
    failFast: { maxConsecutiveFails: MAX_CONSECUTIVE_FAILS },
  };

  try {
    // 0) Pull canonical knowledge.json first (non-fatal if it fails)
    log("⬇️ Pulling knowledge.json from repo…");
    try {
      await pullKnowledge();
    } catch (e) {
      log("⚠️ pullKnowledge failed; continuing with local knowledge.json", { error: e?.message });
    }

    // 1) Ingest
    log("📥 Ingesting…", { mode });
    await ingest(stageOpts);

    // 2) Enrich
    log("✨ Enriching…", { failFastMax: MAX_CONSECUTIVE_FAILS });
    await enrich(stageOpts);

    // 3) Classify
    log("🏷️ Classifying…", { failFastMax: MAX_CONSECUTIVE_FAILS });
    await classify(stageOpts);

    // 4) Digest
    log("📰 Building digest…");
    const digestResult = await digest(stageOpts);

    // 5) Publish local artifacts
    log("📤 Publishing…");
    await publish({ digestResult });

    // 6) Sync knowledge.json upstream
    log("⬆️ Syncing knowledge.json…");
    await syncKnowledge();

    // 7) Sync digest artifacts, if produced
    if (digestResult) {
      log("⬆️ Syncing digest artifacts…");
      await syncDigest(digestResult);
    }

    log("✅ Pipeline completed successfully!");
  } catch (err) {
    log("❌ Pipeline failed", { error: err?.message ?? String(err) });
    process.exit(1);
  }
}

run();
