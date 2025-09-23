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

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");

/* ------------------ Ingest step ------------------ */
export async function ingest() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dayDir = new Date().toISOString().split("T")[0];
  const ingestDir = path.join(INGEST_ROOT, dayDir, timestamp);
  await ensureDir(ingestDir);

  // Placeholder demo item (Raindrop/YouTube/RSS can be added here later)
  const items = [
    {
      id: "demo1",
      title: "Demo Ingest Item",
      url: "https://example.com/demo",
      sourceType: "demo",
      publishedAt: new Date().toISOString(),
    },
  ];

  await saveJsonCheckpoint(path.join(ingestDir, "items.json"), {
    items,
    generatedAt: new Date().toISOString(),
  });

  console.log("Ingest complete:", { itemCount: items.length, dir: ingestDir });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
