import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");
const ENRICH_ROOT = path.join(ROOT_DIR, "data", "enrich");

/**
 * Ensure a directory exists (recursively).
 */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Save JSON to a file (checkpoint style).
 */
async function saveJsonCheckpoint(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, "utf8");
}

/**
 * Load JSON from a file if it exists, otherwise return fallback.
 */
async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * List immediate subdirectories of a parent directory.
 */
async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Get the most recent run (day + timestamp) from a data root.
 */
async function getLatestRun(root) {
  const dayDirs = await listDirectories(root);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();
  for (const day of dayDirs) {
    const stampDirs = await listDirectories(path.join(root, day));
    stampDirs.sort().reverse();
    for (const stamp of stampDirs) {
      const file = path.join(root, day, stamp, "items.json");
      const content = await loadJson(file, null);
      if (content) return { dayDir: day, stampDir: stamp, content };
    }
  }
  return null;
}

/**
 * Enrich step — adds summaries/descriptions.
 */
export async function enrich() {
  const ingestRun = await getLatestRun(INGEST_ROOT);
  if (!ingestRun) {
    console.log("No ingest data found; skip enrich");
    return;
  }

  const enrichDir = path.join(ENRICH_ROOT, ingestRun.dayDir, ingestRun.stampDir);
  await ensureDir(enrichDir);

  const enriched = ingestRun.content.items.map((item) => ({
    ...item,
    summary: `Enriched summary for ${item.title}`,
    description: `More detailed description for ${item.title}`,
  }));

  await saveJsonCheckpoint(path.join(enrichDir, "items.json"), {
    items: enriched,
    generatedAt: new Date().toISOString(),
  });

  console.log("Enrich complete:", { itemCount: enriched.length, dir: enrichDir });
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich failed", err);
    process.exitCode = 1;
  });
}
