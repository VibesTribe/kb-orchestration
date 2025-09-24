import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "ingest-state.json");
const SOURCES_FILE = path.join(ROOT_DIR, "sources.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

/* ------------------ Helpers ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

/* ------------------ Source loading ------------------ */
async function loadSources() {
  return loadJson(SOURCES_FILE, { raindrop: {}, youtube: {}, rss: [] });
}

async function loadState() {
  return loadJson(STATE_FILE, { completedOnce: {} });
}

async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

async function loadKnowledge() {
  return loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });
}

async function saveKnowledge(kb) {
  kb.generatedAt = new Date().toISOString();
  await saveJson(KNOWLEDGE_FILE, kb);
}

/* ------------------ Normalization ------------------ */
function normalizeCollection(collection) {
  if (!collection || collection === "0" || /^\d+$/.test(collection)) return "misc";
  return collection.toLowerCase();
}

/* ------------------ Fake fetchers (stub) ------------------ */
// TODO: replace with real Raindrop, YouTube, RSS fetch logic
async function fetchRaindropItems(collectionId, window) {
  return [
    {
      id: `rd-${collectionId}-${Date.now()}`,
      title: "Demo Raindrop Bookmark",
      url: "https://example.com/bookmark",
      sourceType: "raindrop",
      collection: collectionId,
      publishedAt: new Date().toISOString(),
    },
  ];
}

async function fetchYoutubePlaylistItems(playlistId) {
  return [
    {
      id: `yt-playlist-${playlistId}-${Date.now()}`,
      title: "Demo YouTube Playlist Video",
      url: "https://youtube.com/watch?v=demo",
      sourceType: "youtube-playlist",
      publishedAt: new Date().toISOString(),
    },
  ];
}

async function fetchYoutubeChannelItems(handle, window) {
  return [
    {
      id: `yt-channel-${handle}-${Date.now()}`,
      title: `Demo video from ${handle}`,
      url: "https://youtube.com/watch?v=demo",
      sourceType: "youtube-channel",
      publishedAt: new Date().toISOString(),
    },
  ];
}

async function fetchRssItems(feedId, url, window) {
  return [
    {
      id: `rss-${feedId}-${Date.now()}`,
      title: `Demo RSS article from ${feedId}`,
      url,
      sourceType: "rss",
      publishedAt: new Date().toISOString(),
    },
  ];
}

/* ------------------ Main ingest ------------------ */
export async function ingest() {
  const sources = await loadSources();
  const state = await loadState();
  const kb = await loadKnowledge();

  const newItems = [];

  /* ---- Raindrop ---- */
  for (const c of sources.raindrop.collections ?? []) {
    if (c.mode === "pause") {
      log("Skipping Raindrop (paused)", { collection: c.id });
      continue;
    }

    if (c.mode === "once" && state.completedOnce[`raindrop-${c.id}`]) {
      log("Skipping Raindrop (already ingested once)", { collection: c.id });
      continue;
    }

    log("Fetching Raindrop items", { collection: c.id, mode: c.mode });
    const items = await fetchRaindropItems(c.id, c.window ?? sources.raindrop.defaultWindow);
    for (const item of items) {
      item.collection = normalizeCollection(c.name ?? c.id);
      if (!kb.items.find((i) => i.id === item.id)) {
        kb.items.push(item);
        newItems.push(item);
      }
    }

    if (c.mode === "once") state.completedOnce[`raindrop-${c.id}`] = true;
  }

  /* ---- YouTube playlists ---- */
  for (const p of sources.youtube.playlists ?? []) {
    if (p.mode === "pause") {
      log("Skipping YouTube playlist (paused)", { playlist: p.id });
      continue;
    }
    if (p.mode === "once" && state.completedOnce[`yt-playlist-${p.id}`]) {
      log("Skipping YouTube playlist (already ingested once)", { playlist: p.id });
      continue;
    }

    log("Fetching YouTube playlist items", { playlist: p.id, mode: p.mode });
    const items = await fetchYoutubePlaylistItems(p.id);
    for (const item of items) {
      if (!kb.items.find((i) => i.id === item.id)) {
        kb.items.push(item);
        newItems.push(item);
      }
    }

    if (p.mode === "once") state.completedOnce[`yt-playlist-${p.id}`] = true;
  }

  /* ---- YouTube channels ---- */
  for (const c of sources.youtube.channels ?? []) {
    if (c.mode === "pause") {
      log("Skipping YouTube channel (paused)", { handle: c.handle });
      continue;
    }

    if (c.mode === "weekly-once" && state.completedOnce[`yt-channel-weekly-${c.handle}`]) {
      log("Weekly once already done → falling back to daily", { handle: c.handle });
      const items = await fetchYoutubeChannelItems(c.handle, sources.youtube.defaultWindow);
      for (const item of items) {
        if (!kb.items.find((i) => i.id === item.id)) {
          kb.items.push(item);
          newItems.push(item);
        }
      }
    } else {
      log("Fetching YouTube channel items", { handle: c.handle, mode: c.mode });
      const items = await fetchYoutubeChannelItems(c.handle, c.window ?? sources.youtube.defaultWindow);
      for (const item of items) {
        if (!kb.items.find((i) => i.id === item.id)) {
          kb.items.push(item);
          newItems.push(item);
        }
      }
      if (c.mode === "weekly-once") state.completedOnce[`yt-channel-weekly-${c.handle}`] = true;
    }
  }

  /* ---- RSS feeds ---- */
  for (const f of sources.rss ?? []) {
    if (f.mode === "pause") {
      log("Skipping RSS (paused)", { feed: f.id });
      continue;
    }
    if (f.mode === "once" && state.completedOnce[`rss-${f.id}`]) {
      log("Skipping RSS (already ingested once)", { feed: f.id });
      continue;
    }

    log("Fetching RSS feed items", { feed: f.id, mode: f.mode });
    const items = await fetchRssItems(f.id, f.url, f.window);
    for (const item of items) {
      if (!kb.items.find((i) => i.id === item.id)) {
        kb.items.push(item);
        newItems.push(item);
      }
    }

    if (f.mode === "once") state.completedOnce[`rss-${f.id}`] = true;
  }

  /* ---- Save everything ---- */
  if (newItems.length) {
    log(`Ingested ${newItems.length} new items`, { newItems: newItems.length });
    await saveKnowledge(kb);
  } else {
    log("No new items found this run");
  }

  await saveState(state);
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
