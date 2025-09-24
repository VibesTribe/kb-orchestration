import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "pipeline-state.json");
const STATS_FILE = path.join(CACHE_ROOT, "stats.json");
const SYSTEM_STATUS_FILE = path.join(CACHE_ROOT, "system-status.json");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");

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

async function mostRecentCurated() {
  try {
    const days = (await fs.readdir(CURATED_ROOT, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();
    for (const day of days) {
      const stamps = (await fs.readdir(path.join(CURATED_ROOT, day), { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .reverse();
      if (stamps.length) {
        return path.join(CURATED_ROOT, day, stamps[0], "items.json");
      }
    }
  } catch {}
  return null;
}

async function mostRecentDigest() {
  try {
    const days = (await fs.readdir(DIGEST_ROOT, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();
    for (const day of days) {
      const stamps = (await fs.readdir(path.join(DIGEST_ROOT, day), { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .reverse();
      if (stamps.length) {
        return path.join(DIGEST_ROOT, day, stamps[0], "digest.json");
      }
    }
  } catch {}
  return null;
}

export async function buildSystemStatus(pipeline = null) {
  const state = await loadJson(STATE_FILE, { completed: [] });
  const stats = await loadJson(STATS_FILE, {
    ingested: 0, enriched: 0, classified: 0, digests: 0, published: 0
  });

  const curatedPath = await mostRecentCurated();
  const curated = curatedPath ? await loadJson(curatedPath, null) : null;

  const digestPath = await mostRecentDigest();
  const digest = digestPath ? await loadJson(digestPath, null) : null;

  const payload = {
    generatedAt: new Date().toISOString(),
    pipeline: pipeline ?? {
      lastRunStep: state.completed[state.completed.length - 1] || null,
      completedSteps: state.completed,
      stats
    },
    knowledgebase: curated,
    digest
  };

  await ensureDir(path.dirname(SYSTEM_STATUS_FILE));
  await fs.writeFile(SYSTEM_STATUS_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✅ System status written ${SYSTEM_STATUS_FILE}`, {
    generatedAt: payload.generatedAt,
    pipeline: payload.pipeline
  });

  return payload;
}

// run direct for debugging
if (import.meta.url === `file://${process.argv[1]}`) {
  buildSystemStatus().catch((e) => {
    console.error("system-status failed", e);
    process.exitCode = 1;
  });
}
