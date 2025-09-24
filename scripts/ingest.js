// scripts/ingest.js
// Reads config/sources.json and writes ingest checkpoints under data/ingest/

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CONFIG_FILE = path.join(ROOT_DIR, "config", "sources.json");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function saveJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, "utf8");
}

export async function ingest() {
  let sources;
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    sources = JSON.parse(raw);
  } catch (err) {
    console.warn("No valid config/sources.json found; skipping ingest");
    return [];
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dayDir = new Date().toISOString().split("T")[0];
  const ingestDir = path.join(INGEST_ROOT, dayDir, timestamp);
  await ensureDir(ingestDir);

  // Minimal example: just log sources and checkpoint
  const items = [];
  if (sources.raindrop?.collections?.length) {
    for (const c of sources.raindrop.collections) {
      items.push({
        id: `raindrop-${c.id}`,
        title: `Raindrop collection ${c.name}`,
        sourceType: "raindrop",
        mode: c.mode,
        collectedAt: new Date().toISOString(),
      });
    }
  }
  if (sources.youtube?.playlists?.length) {
    for (const p of sources.youtube.playlists) {
      items.push({
        id: `yt-${p.id}`,
        title: `YouTube playlist ${p.id}`,
        sourceType: "youtube-playlist",
        mode: p.mode,
        collectedAt: new Date().toISOString(),
      });
    }
  }

  await saveJson(path.join(ingestDir, "items.json"), {
    items,
    generatedAt: new Date().toISOString(),
  });

  console.log("Ingest complete:", {
    itemCount: items.length,
    dir: ingestDir,
  });

  return items;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
