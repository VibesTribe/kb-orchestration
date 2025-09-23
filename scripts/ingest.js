import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveJsonCheckpoint, ensureDir } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");

// Placeholder ingestion (Raindrop/YouTube/RSS would go here)
export async function ingest() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dayDir = new Date().toISOString().split("T")[0];
  const ingestDir = path.join(INGEST_ROOT, dayDir, timestamp);
  await ensureDir(ingestDir);

  const items = [
    {
      id: "demo1",
      title: "Demo Ingest Item",
      url: "https://example.com/demo",
      sourceType: "demo",
      publishedAt: new Date().toISOString(),
    },
  ];

  await saveJsonCheckpoint(path.join(ingestDir, "items.json"), { items, generatedAt: new Date().toISOString() });
  console.log("Ingest complete:", { itemCount: items.length, dir: ingestDir });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
