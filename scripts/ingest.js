// scripts/ingest.js
// Reads config/sources.json and pulls actual items into data/ingest/

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

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

async function fetchRaindropCollection(collectionId, token) {
  const items = [];
  let page = 0;
  while (true) {
    const res = await fetch(
      `https://api.raindrop.io/rest/v1/raindrops/${collectionId}?perpage=50&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Raindrop fetch failed ${res.status}`);
    const data = await res.json();
    if (!data.items?.length) break;
    for (const it of data.items) {
      items.push({
        id: `raindrop-${it._id}`,
        title: it.title,
        url: it.link,
        created: it.created,
        tags: it.tags,
        sourceType: "raindrop",
      });
    }
    page++;
  }
  return items;
}

async function fetchYouTubePlaylist(playlistId, apiKey) {
  const items = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.search = new URLSearchParams({
      part: "snippet",
      maxResults: "50",
      playlistId,
      key: apiKey,
      pageToken,
    });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube fetch failed ${res.status}`);
    const data = await res.json();

    for (const it of data.items ?? []) {
      const snip = it.snippet;
      if (!snip) continue;
      items.push({
        id: `yt-${snip.resourceId?.videoId}`,
        title: snip.title,
        url: `https://www.youtube.com/watch?v=${snip.resourceId?.videoId}`,
        publishedAt: snip.publishedAt,
        sourceType: "youtube",
      });
    }

    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dayDir = new Date().toISOString().split("T")[0];
  const ingestDir = path.join(INGEST_ROOT, dayDir, timestamp);
  await ensureDir(ingestDir);

  const allItems = [];

  // 🔹 Raindrop collections
  if (sources.raindrop?.collections?.length) {
    for (const c of sources.raindrop.collections) {
      try {
        const raindrops = await fetchRaindropCollection(
          c.id,
          process.env.RAINDROP_TOKEN
        );
        allItems.push(...raindrops);
        console.log(`Fetched ${raindrops.length} from Raindrop ${c.name}`);
      } catch (err) {
        console.error("Raindrop error", c.name, err);
      }
    }
  }

  // 🔹 YouTube playlists
  if (sources.youtube?.playlists?.length) {
    for (const p of sources.youtube.playlists) {
      try {
        const vids = await fetchYouTubePlaylist(
          p.id,
          process.env.YOUTUBE_API_KEY
        );
        allItems.push(...vids);
        console.log(`Fetched ${vids.length} from YouTube playlist ${p.id}`);
      } catch (err) {
        console.error("YouTube playlist error", p.id, err);
      }
    }
  }

  await saveJson(path.join(ingestDir, "items.json"), {
    items: allItems,
    generatedAt: new Date().toISOString(),
  });

  console.log("Ingest complete:", {
    itemCount: allItems.length,
    dir: ingestDir,
  });

  return allItems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
