// scripts/run-pipeline.js
// Orchestrates the full incremental knowledge pipeline:
// ingest → enrich → classify → digest → publish → sync upstream
//
// Additions:
// - Bootstrap awareness via data/cache/bootstrap-state.json
// - Per-stage fail-fast thresholds (plumbed as options; stages may ignore until updated)
// - Clear, mode-specific logging
// - Marks bootstrap done only after a fully successful run

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
import { digest } from "./digest.js";
import { publish } from "./publish.js";
import { syncKnowledge, syncDigest } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "cache");
const BOOTSTRAP_STATE_FILE = path.join(CACHE_DIR, "bootstrap-state.json");

// ---- Config (env overrides allowed) ----
const MAX_CONSECUTIVE_FAILS = Number(process.env.MAX_CONSECUTIVE_FAILS ?? 5);

// Helpers
function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  // Avoid noisy empty {}
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readBootstrapState() {
  await ensureCacheDir();
  try {
    const raw = await fs.readFile(BOOTSTRAP_STATE_FILE, "utf8");
    const j = JSON.parse(raw);
    return {
      bootstrapDone: Boolean(j?.bootstrapDone),
      completedAt: j?.completedAt ?? null,
    };
  } catch {
    return { bootstrapDone: false, completedAt: null };
  }
}

async function writeBootstrapDone() {
  await ensureCacheDir();
  const payload = {
    bootstrapDone: true,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(BOOTSTRAP_STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  log("📌 Bootstrap marked complete", payload);
}

async function run() {
  log("🚀 Starting knowledge pipeline…");

  // Determine mode (bootstrap vs daily)
  const boot = await readBootstrapState();
  const mode = boot.bootstrapDone ? "daily" : "bootstrap";

  log("🧭 Mode selected", {
    mode,
    bootstrapDone: boot.bootstrapDone,
    maxConsecutiveFails: MAX_CONSECUTIVE_FAILS,
  });

  // Options we pass to stages. Stages may ignore until updated, but this is forward-compatible.
  const stageOpts = {
    mode, // "bootstrap" | "daily"
    failFast: { maxConsecutiveFails: MAX_CONSECUTIVE_FAILS },
    // You can add stage-specific knobs here later, e.g. windows:
    // windows: { channelsHours: mode === "bootstrap" ? 48 : 24, raindropHours: 24, playlists: mode === "bootstrap" ? "full" : "skip" }
  };

  try {
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

    // If we reached here successfully in bootstrap mode, mark it done
    if (mode === "bootstrap") {
      await writeBootstrapDone();
    }

    log("✅ Pipeline completed successfully!");
  } catch (err) {
    // Stages that implement fail-fast should throw; we just surface and exit non-zero.
    log("❌ Pipeline failed", { error: err?.message ?? String(err) });
    process.exit(1);
  }
}

run();
