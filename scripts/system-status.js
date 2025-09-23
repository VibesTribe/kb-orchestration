import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const STATUS_FILE = path.join(CACHE_ROOT, "system-status.json");

// Helpers
async function safeLoadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function getLatestCuratedRun() {
  const dayDirs = await listDirectories(CURATED_ROOT);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();

  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(CURATED_ROOT, dayDir));
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(CURATED_ROOT, dayDir, stampDir, "items.json");
      const content = await safeLoadJson(itemsPath, null);
      if (content) {
        return { dayDir, stampDir, itemsPath, content };
      }
    }
  }
  return null;
}

export async function buildSystemStatus() {
  const raindropRefresh = await safeLoadJson(
    path.join(CACHE_ROOT, "raindrop-refresh.json")
  );
  const pipelineState = await safeLoadJson(
    path.join(CACHE_ROOT, "pipeline-state.json"),
    { completed: [] }
  );
  const curatedRun = await getLatestCuratedRun();

  const status = {
    generatedAt: new Date().toISOString(),
    raindrop: raindropRefresh
      ? {
          lastRefreshed: raindropRefresh.refreshedAt,
          expiresAt: raindropRefresh.expiresAt,
          targetSecret: raindropRefresh.targetSecret
        }
      : null,
    pipeline: {
      lastRunStep: pipelineState.completed?.slice(-1)[0] ?? null,
      completedSteps: pipelineState.completed ?? []
    },
    knowledgebase: curatedRun
      ? {
          lastUpdated: curatedRun.content.generatedAt,
          items: curatedRun.content.items?.length ?? 0
        }
      : null
  };

  await fs.mkdir(CACHE_ROOT, { recursive: true });
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2), "utf8");

  console.log("✅ System status written", STATUS_FILE, status);
  return status;
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildSystemStatus().catch((err) => {
    console.error("❌ Failed to build system status", err);
    process.exitCode = 1;
  });
}
