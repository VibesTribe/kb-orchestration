import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATUS_FILE = path.join(CACHE_DIR, "system-status.json");

/* ---------- Helpers ---------- */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
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

function log(message, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`, Object.keys(ctx).length ? ctx : "");
}

/* ---------- Main ---------- */
export async function buildSystemStatus(partialStats = {}) {
  const prev = await loadJson(STATUS_FILE, {
    generatedAt: new Date().toISOString(),
    pipeline: {
      lastRunStep: null,
      completedSteps: [],
      stats: { ingested: 0, enriched: 0, classified: 0, digests: 0, published: 0 },
    },
    knowledgebase: null,
    digest: null,
  });

  const stats = {
    ...prev.pipeline.stats,
    ...Object.fromEntries(
      Object.entries(partialStats).map(([k, v]) => [
        k,
        typeof v === "number" ? (prev.pipeline.stats[k] ?? 0) + v : v,
      ])
    ),
  };

  const updated = {
    ...prev,
    generatedAt: new Date().toISOString(),
    pipeline: {
      ...prev.pipeline,
      lastRunStep: partialStats.lastRunStep ?? prev.pipeline.lastRunStep,
      completedSteps: Array.from(
        new Set([...prev.pipeline.completedSteps, ...(partialStats.completedSteps ?? [])])
      ),
      stats,
    },
  };

  await saveJson(STATUS_FILE, updated);
  log("✅ System status written", { file: path.relative(ROOT_DIR, STATUS_FILE), stats });
  return updated;
}

/* ---------- Run direct ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  buildSystemStatus().catch((err) => {
    console.error("System status update failed", err);
    process.exitCode = 1;
  });
}
