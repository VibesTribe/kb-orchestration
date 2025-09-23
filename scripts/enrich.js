import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJson } from "./lib/utils.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");
const ENRICH_ROOT = path.join(ROOT_DIR, "data", "enrich");

export async function enrich() {
  const ingestRun = await getLatestRun(INGEST_ROOT);
  if (!ingestRun) {
    console.log("No ingested data found; skip enrich");
    return;
  }

  const enrichDir = path.join(ENRICH_ROOT, ingestRun.dayDir, ingestRun.stampDir);
  await ensureDir(enrichDir);

  const enriched = ingestRun.content.items.map((item) => ({
    ...item,
    summary: `Auto-generated summary for ${item.title}`,
    description: `Description for ${item.title}`,
  }));

  await saveJsonCheckpoint(path.join(enrichDir, "items.json"), {
    items: enriched,
    generatedAt: new Date().toISOString(),
  });

  console.log("Enrich complete:", { itemCount: enriched.length, dir: enrichDir });
}

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

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrich failed", err);
    process.exitCode = 1;
  });
}
