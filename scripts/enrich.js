import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Local utilities ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
async function saveJsonCheckpoint(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, "utf8");
}
async function loadJson(filePath, fallback) {
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

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");
const ENRICH_ROOT = path.join(ROOT_DIR, "data", "enrich");

/* ------------------ Enrich step ------------------ */
export async function enrich() {
  const ingestRun = await getLatestRun(INGEST_ROOT);
  if (!ingestRun) {
    console.log("No ingested data found; skip enrich");
    return;
  }

  const enrichDir = path.join(ENRICH_ROOT, ingestRun.dayDir, ingestRun.stampDir);
  await ensureDir(enrichDir);

  // Simple demo enrichment: add a `summary`
  const enriched = ingestRun.content.items.map((item) => ({
    ...item,
    summary: `Enriched summary for ${item.title}`,
  }));

  await saveJsonCheckpoint(path.join(enrichDir, "items.json"), {
    items: enriched,
    generatedAt: new Date().toISOString(),
  });

  console.log("Enrich complete:", { itemCount: enriched.length, dir: enrichDir });
}

/* ------------------ Helper ------------------ */
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

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich failed", err);
    process.exitCode = 1;
  });
}
