// scripts/ingest.js
// Reads config/sources.json and writes ingest checkpoints under data/ingest/

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Go up ONE level to repo root (scripts -> repoRoot)
const ROOT_DIR = path.resolve(__dirname, "..");
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
  } catch {
    console.warn("No valid config/sources.json found; skipping ingest");
    return [];
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const dayDir = now.toISOString().split("T")[0];
  const ingestDir = path.join(INGEST_ROOT, dayDir, timestamp);
  await ensureDir(ingestDir);

  const items = [];

  if (sources.raindrop?.collections?.length) {
    for (const c of sources.raindrop.collections) {
      items.push({
        id: `raindrop-${c.id}`,
        title: `Raindrop collection ${c.name}`,
        sourceType: "raindrop",
        mode: c.mode,
        collectedAt: now.toISOString(),
      });
    }
  }

  if (sources.youtube?.playlists?.length) {
    for (const p of sources.youtube.playlists) {
      items.push({
        id: `yt-pl-${p.id}`,
        title: `YouTube playlist ${p.id}`,
        sourceType: "youtube-playlist",
        mode: p.mode,
        collectedAt: now.toISOString(),
      });
    }
  }

  if (sources.youtube?.channels?.length) {
    for (const ch of sources.youtube.channels) {
      items.push({
        id: `yt-ch-${ch.handle}`,
        title: `YouTube channel @${ch.handle}`,
        sourceType: "youtube-channel",
        mode: ch.mode,
        collectedAt: now.toISOString(),
      });
    }
  }

  if (Array.isArray(sources.rss)) {
    for (const r of sources.rss) {
      items.push({
        id: `rss-${r.id}`,
        title: `RSS ${r.id}`,
        sourceType: "rss",
        mode: r.mode ?? "once",
        collectedAt: now.toISOString(),
      });
    }
  }

  await saveJson(path.join(ingestDir, "items.json"), {
    items,
    generatedAt: now.toISOString(),
  });

  console.log("Ingest complete:", { itemCount: items.length, dir: ingestDir });
  return items;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
