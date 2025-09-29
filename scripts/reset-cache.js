// scripts/reset-cache.js
// Clears orchestration cache (data/cache) without touching knowledge.json

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const CACHE_DIR = path.join(ROOT, "data", "cache");

async function resetCache() {
  try {
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
    console.log(`🗑️ Deleted cache dir: ${CACHE_DIR}`);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    console.log(`✅ Reset complete: ${CACHE_DIR} recreated empty`);
  } catch (err) {
    console.error("❌ Reset cache failed", err);
    process.exit(1);
  }
}

resetCache();
