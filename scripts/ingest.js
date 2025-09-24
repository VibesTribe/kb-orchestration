// scripts/ingest.js
// Ingest real data from Raindrop + YouTube, guided by config/sources.json

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CONFIG_FILE = path.join(ROOT_DIR, "config", "sources.json");
const INGEST_ROOT = path.join(ROOT_DIR, "data", "ingest");

const raindropToken = process.env.RAINDROP_TOKEN;
const youtubeKey = process.env.YOUTUBE_API_KEY;

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function saveJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function ingestRaindrop(collections) {
  if (!raindropToken) {
    console.warn("No RAINDROP_TOKEN; skipping Raindrop");
    return [];
  }
  const results = [];
  for (const c of collections) {
    const url = `https://api.raindrop.io/rest/v1/raindrop/${c.id}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${raindropToken}` },
    });
    if (!res.ok) {
      console.warn(`Raindrop fetch failed for ${c.id}: ${res.status}`);
      continue;
    }
    const json = await res.json();
    if (json?.item) {
      results.push({
        id: `raindrop-${c.id}`,
        title: json.item.title,
        url: json.item.link,
        sourceType: "raindrop",
        mode: c.mode,
        collectedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}

async function ingestYouTube(playlists) {
  if (!youtubeKey) {
    console.warn("No YOUTUBE_API_KEY; skipping YouTube");
    return [];
  }
  const results = [];
  for (const p of playlists) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=${p.id}&key=${youtubeKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`YouTube fetch failed for ${p.id}: ${res.status}`);
      continue;
    }
    const json = await res.json();
    for (const item of json.items || []) {
      results.push({
        id: `yt-${item.id}`,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
        sourceType: "youtube-playlist",
        mode: p.mode,
        collectedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}

export async function ingest() {
  let sources;
  try {
    sources = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  } catch {
    console.warn("No valid config/sources.json found; skipping ingest");
    return [];
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dayDir = new Date().toISOString().split("T")[0];
  const ingestDir = path.join(INGEST_ROOT, dayDir, timestamp);
  await ensureDir(ingestDir);

  let items = [];
  if (sources.raindrop?.collections?.length) {
    items = items.concat(await ingestRaindrop(sources.raindrop.collections));
  }
  if (sources.youtube?.playlists?.length) {
    items = items.concat(await ingestYouTube(sources.youtube.playlists));
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
