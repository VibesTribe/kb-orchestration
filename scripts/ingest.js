import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import Parser from "rss-parser";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "ingest-state.json");
const SOURCES_FILE = path.join(ROOT_DIR, "sources.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

/* ------------------ Secrets ------------------ */
const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

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
function normalizeCollection(collection) {
  if (!collection || collection === "0" || /^\d+$/.test(collection)) return "misc";
  return collection.toLowerCase();
}

/* ------------------ Load state & sources ------------------ */
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

/* ------------------ Raindrop ------------------ */
async function fetchRaindropItems(collectionId, window) {
  if (!RAINDROP_TOKEN) throw new Error("RAINDROP_TOKEN missing");
  const items = [];
  let page = 0;
  let keepGoing = true;

  while (keepGoing) {
    const res = await fetch(
      `https://api.raindrop.io/rest/v1/raindrops/${collectionId}?perpage=50&page=${page}`,
      { headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`Raindrop error: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (!json.items || !json.items.length) break;

    for (const it of json.items) {
      items.push({
        id: `rd-${it._id}`,
        title: it.title,
        url: it.link,
        sourceType: "raindrop",
        collection: normalizeCollection(collectionId),
        publishedAt: it.created || new Date().toISOString(),
        tags: it.tags ?? [],
      });
    }

    if (json.items.length < 50) keepGoing = false;
    page++;
  }
  return items;
}

/* ------------------ YouTube ------------------ */
async function fetchYoutubePlaylistItems(playlistId) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY missing");
  const items = [];
  let pageToken = "";

  while (true) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", YOUTUBE_API_KEY);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`YouTube playlist error: ${res.status} ${await res.text()}`);
    const json = await res.json();

    for (const it of json.items ?? []) {
      items.push({
        id: `yt-playlist-${playlistId}-${it.contentDetails.videoId}`,
        title: it.snippet.title,
        url: `https://www.youtube.com/watch?v=${it.contentDetails.videoId}`,
        sourceType: "youtube-playlist",
        publishedAt: it.contentDetails.videoPublishedAt,
      });
    }

    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return items;
}

async function fetchYoutubeChannelItems(handle, window) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY missing");
  const items = [];

  // 1. Resolve channel ID
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("q", handle);
  searchUrl.searchParams.set("type", "channel");
  searchUrl.searchParams.set("maxResults", "1");
  searchUrl.searchParams.set("key", YOUTUBE_API_KEY);

  const searchRes = await fetch(searchUrl.toString());
  if (!searchRes.ok) throw new Error(`YouTube channel search error: ${searchRes.status}`);
  const searchJson = await searchRes.json();
  const channelId = searchJson.items?.[0]?.id?.channelId;
  if (!channelId) return items;

  // 2. Fetch recent videos
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  videosUrl.searchParams.set("part", "snippet");
  videosUrl.searchParams.set("channelId", channelId);
  videosUrl.searchParams.set("order", "date");
  videosUrl.searchParams.set("maxResults", "20");
  videosUrl.searchParams.set("key", YOUTUBE_API_KEY);

  const res = await fetch(videosUrl.toString());
  if (!res.ok) throw new Error(`YouTube videos error: ${res.status} ${await res.text()}`);
  const json = await res.json();

  for (const it of json.items ?? []) {
    if (it.id.kind !== "youtube#video") continue;
    items.push({
      id: `yt-channel-${handle}-${it.id.videoId}`,
      title: it.snippet.title,
      url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      sourceType: "youtube-channel",
      publishedAt: it.snippet.publishedAt,
    });
  }
  return items;
}

/* ------------------ RSS ------------------ */
async function fetchRssItems(feedId, url) {
  const parser = new Parser();
  const feed = await parser.parseURL(url);
  return (feed.items ?? []).map((it, idx) => ({
    id: `rss-${feedId}-${idx}`,
    title: it.title,
    url: it.link,
    sourceType: "rss",
    publishedAt: it.isoDate || it.pubDate || new Date().toISOString(),
  }));
}

/* ------------------ Main ingest ------------------ */
export async function ingest() {
  const sources = await loadSources();
  const state = await loadState();
  const kb = await loadKnowledge();

  const newItems = [];

  /* ---- Raindrop ---- */
  for (const c of sources.raindrop.collections ?? []) {
    if (c.mode === "pause") continue;
    if (c.mode === "once" && state.completedOnce[`raindrop-${c.id}`]) continue;

    const items = await fetchRaindropItems(c.id, c.window ?? sources.raindrop.defaultWindow);
    for (const item of items) {
      if (!kb.items.find((i) => i.id === item.id)) {
        kb.items.push(item);
        newItems.push(item);
      }
    }
    if (c.mode === "once") state.completedOnce[`raindrop-${c.id}`] = true;
  }

  /* ---- YouTube playlists ---- */
  for (const p of sources.youtube.playlists ?? []) {
    if (p.mode === "pause") continue;
    if (p.mode === "once" && state.completedOnce[`yt-playlist-${p.id}`]) continue;

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
    if (c.mode === "pause") continue;
    if (c.mode === "weekly-once" && state.completedOnce[`yt-channel-weekly-${c.handle}`]) {
      // already did full pull → skip
      continue;
    }

    const items = await fetchYoutubeChannelItems(c.handle, c.window ?? sources.youtube.defaultWindow);
    for (const item of items) {
      if (!kb.items.find((i) => i.id === item.id)) {
        kb.items.push(item);
        newItems.push(item);
      }
    }
    if (c.mode === "weekly-once") state.completedOnce[`yt-channel-weekly-${c.handle}`] = true;
  }

  /* ---- RSS feeds ---- */
  for (const f of sources.rss ?? []) {
    if (f.mode === "pause") continue;
    if (f.mode === "once" && state.completedOnce[`rss-${f.id}`]) continue;

    const items = await fetchRssItems(f.id, f.url);
    for (const item of items) {
      if (!kb.items.find((i) => i.id === item.id)) {
        kb.items.push(item);
        newItems.push(item);
      }
    }
    if (f.mode === "once") state.completedOnce[`rss-${f.id}`] = true;
  }

  /* ---- Save ---- */
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

