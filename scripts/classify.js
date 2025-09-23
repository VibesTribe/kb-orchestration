import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, loadJson, saveJson } from "./lib/utils.js";



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ENRICH_ROOT = path.join(ROOT_DIR, "data", "enrich");
const CLASSIFY_ROOT = path.join(ROOT_DIR, "data", "classify");

export async function classify() {
  const enrichRun = await getLatestRun(ENRICH_ROOT);
  if (!enrichRun) {
    console.log("No enriched data found; skip classify");
    return;
  }

  const classifyDir = path.join(CLASSIFY_ROOT, enrichRun.dayDir, enrichRun.stampDir);
  await ensureDir(classifyDir);

  const classified = enrichRun.content.items.map((item) => ({
    ...item,
    tags: ["auto-tag"],
    projects: [
      {
        project: "Vibeflow",
        projectKey: "vibeflow",
        usefulness: "HIGH",
        reason: "Demo classification",
      },
    ],
  }));

  await saveJsonCheckpoint(path.join(classifyDir, "items.json"), {
    items: classified,
    generatedAt: new Date().toISOString(),
  });

  console.log("Classify complete:", { itemCount: classified.length, dir: classifyDir });
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
  classify().catch((err) => {
    console.error("Classify failed", err);
    process.exitCode = 1;
  });
}
