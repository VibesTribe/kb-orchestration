// scripts/ingest.js
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function ingest() {
  const cacheDir = path.resolve(__dirname, "../data/cache");
  await mkdir(cacheDir, { recursive: true });

  // ✅ Correct location of your sources.json
  const sourcesPath = path.resolve(__dirname, "../config/sources.json");

  let sources;
  try {
    const raw = await readFile(sourcesPath, "utf8");
    sources = JSON.parse(raw);
  } catch (e) {
    console.warn("⚠️ No config/sources.json found; skipping ingest");
    return [];
  }

  const results = [];

  if (sources.raindrop?.collections?.length) {
    console.log(
      `📚 Found ${sources.raindrop.collections.length} Raindrop collections`
    );
    for (const c of sources.raindrop.collections) {
      results.push({ type: "raindrop", id: c.id, name: c.name, mode: c.mode });
    }
  }

  if (sources.youtube?.playlists?.length || sources.youtube?.channels?.length) {
    console.log(
      `📺 Found ${sources.youtube.playlists?.length ?? 0} playlists and ${
        sources.youtube.channels?.length ?? 0
      } channels`
    );
    for (const p of sources.youtube.playlists ?? []) {
      results.push({ type: "youtube-playlist", id: p.id, mode: p.mode });
    }
    for (const ch of sources.youtube.channels ?? []) {
      results.push({ type: "youtube-channel", handle: ch.handle, mode: ch.mode });
    }
  }

  if (sources.rss?.length) {
    console.log(`📰 Found ${sources.rss.length} RSS feeds`);
    for (const feed of sources.rss) {
      results.push({ type: "rss", id: feed.id, url: feed.url, mode: feed.mode });
    }
  }

  // Write snapshot to cache for later steps
  const outPath = path.join(cacheDir, "ingest.json");
  await writeFile(outPath, JSON.stringify(results, null,
