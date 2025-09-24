import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "pipeline-state.json");
const STATUS_FILE = path.join(CACHE_ROOT, "system-status.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");

/* ------------------ Helpers ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
async function loadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function saveJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/* ------------------ Builders ------------------ */
async function getLatestDigest() {
  const dayDirs = await listDirectories(DIGEST_ROOT);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();

  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(DIGEST_ROOT, dayDir));
    if (!stampDirs.length) continue;
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const digestPath = path.join(DIGEST_ROOT, dayDir, stampDir, "digest.json");
      const digest = await loadJson(digestPath, null);
      if (digest) return digest;
    }
  }
  return null;
}

/* ------------------ Main ------------------ */
export async function buildSystemStatus() {
  const state = await loadJson(STATE_FILE, { completed: [] });
  const kb = await loadJson(KNOWLEDGE_FILE, null);
  const digest = await getLatestDigest();

  const status = {
    generatedAt: new Date().toISOString(),
    pipeline: {
      lastRunStep: state.completed[state.completed.length - 1] ?? null,
      completedSteps: state.completed,
      stats: {
        ingested: kb?.items?.length ?? 0,
        enriched: kb?.items?.filter((i) => i.summary && i.description).length ?? 0,
        classified: kb?.items?.filter((i) => i.assignedProjects).length ?? 0,
        digests: digest ? 1 : 0,
        published: 0, // updated only by publish.js if needed
      },
    },
    knowledgebase: kb,
    digest,
  };

  await saveJson(STATUS_FILE, status);
  console.log("✅ System status written", STATUS_FILE, status);
  return status;
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  buildSystemStatus().catch((err) => {
    console.error("System status build failed", err);
    process.exitCode = 1;
  });
}
