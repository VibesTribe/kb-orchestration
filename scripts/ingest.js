// scripts/ingest.js
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

/* ───────── Paths & Constants ───────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "ingest-state.json");
const SOURCES_FILE = path.join(ROOT_DIR, "sources.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

const RAINDROP_API = "https://api.raindrop.io/rest/v1";
const YT_API = "https://www.googleapis.com/youtube/v3";

const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const rss = new (class extends Parser {})();

/* ───────── Utils ───────── */
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
async function loadJson(f, fb) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return fb; } }
async function saveJson(f, d) { await ensureDir(path.dirname(f)); await fs.writeFile(f, JSON.stringify(d, null, 2), "utf8"); }
function log(msg, ctx = {}) { const ts = new Date().toISOString(); console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : ""); }

function windowToSinceISO(win = "1d") {
  const m = String(win).match(/^(\d+)\s*(d|w|m)$/i);
  const now = new Date();
  if (!m) return new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  let ms = 24 * 3600 * 1000;
  if (unit === "w") ms *= 7;
  if (unit === "m") ms *= 30;
  return new Date(now.getTime() - n * ms).toISOString();
}
function normalizeCollection(c) {
  if (!c || c === "0" || /^\d+$/.test(c)) return "misc";
  return String(c).toLowerCase();
}

/* Track new insertions */
function pushIfNew(kbItems, item, newItems) {
  if (!kbItems.find((i) => i.id === item.id)) {
    kbItems.push(item);
    newItems.push(item);
  }
}

/* ───────── Loaders ───────── */
async function loadSources() {
  return loadJson(SOURCES_FILE, { raindrop: {}, youtube: {}, rss: [] });
}
async function loadState() {
  return loadJson(STATE_FILE, { completedOnce: {}, lastCount: 0 });
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

/* ───────── Raindrop ───────── */
async function fetchRaindropCollection({ collectionId, sinceISO, perPage = 100 }) {
  if (!RAINDROP_TOKEN) throw new Error("RAINDROP_TOKEN is not configured");

  const searchQuery = sinceISO ? `created:>=${sinceISO}` : undefined;
  let page = 0;
  const out = [];

  while (true) {
    const u = new URL(`${RAINDROP_API}/raindrops/${collectionId}`);
    u.searchParams.set("perpage", String(perPage));
    u.searchParams.set("page", String(page));
    u.searchParams.set("sort", "-created");
    if (searchQuery) u.searchParams.set("search", searchQuery);

    const res = await fetch(u.toString(), {
      headers: { Authorization: `Bearer ${RAINDROP_TOKEN}`, Accept: "application/json" }
    });
    if (!res.ok) throw new Error(`Raindrop ${collectionId} failed: ${res.status} ${await res.text()}`);

    const json = await res.json();
    const items = json.items ?? [];
    if (!items.length) break;

    for (const it of items) {
      out.push({
        id: `raindrop:${it._id}`,
        title: it.title ?? "(untitled)",
        url: it.link ?? null,
        sourceType: "raindrop",
        collection: it.collection?.title ?? String(collectionId),
        tags: it.tags ?? [],
        publishedAt: it.created ?? it.lastUpdate ?? new Date().toISOString(),
        thumbnail: it.cover ?? null
      });
    }

    if (sinceISO) {
      const oldest = items[items.length - 1]?.created;
      if (oldest && new Date(oldest) < new Date(sinceISO)) break;
    }
    page += 1;
  }
  return out;
}

/* ───────── YouTube ───────── */
async function resolveChannelIdFromHandle(handle) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not configured");

  const q = handle.startsWith("@") ? handle : `@${handle}`;
  const u = new URL(`${YT_API}/search`);
  u.searchParams.set("part", "snippet");
  u.searchParams.set("q", q);
  u.searchParams.set("type", "channel");
  u.searchParams.set("maxResults", "1");
  u.searchParams.set("key", YOUTUBE_API_KEY);

  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`YouTube handle search failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const ch = json.items?.[0]?.snippet?.channelId || json.items?.[0]?.id?.channelId;
  if (!ch) throw new Error(`Channel not found for handle ${handle}`);
  return ch;
}

async function fetchChannelVideos({ channelId, sinceISO }) {
  const out = [];
  let pageToken = null;

  do {
    const u = new URL(`${YT_API}/search`);
    u.searchParams.set("part", "snippet");
    u.searchParams.set("channelId", channelId);
    u.searchParams.set("type", "video");
    u.searchParams.set("order", "date");
    if (sinceISO) u.searchParams.set("publishedAfter", sinceISO);
    u.searchParams.set("maxResults", "50");
    u.searchParams.set("key", YOUTUBE_API_KEY);
    if (pageToken) u.searchParams.set("pageToken", pageToken);

    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`YouTube channel videos failed: ${res.status} ${await res.text()}`);

    const json = await res.json();
    for (const it of json.items ?? []) {
      const vid = it.id?.videoId;
      const sn = it.snippet ?? {};
      if (!vid) continue;
      out.push({
        id: `youtube:video:${vid}`,
        title: sn.title ?? "(untitled)",
        url: `https://www.youtube.com/watch?v=${vid}`,
        sourceType: "youtube-channel",
        publishedAt: sn.publishedAt ?? new Date().toISOString(),
        thumbnail: sn.thumbnails?.high?.url ?? sn.thumbnails?.default?.url ?? null,
        tags: [],
      });
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  return out;
}

async function fetchPlaylistItems({ playlistId, sinceISO }) {
  const out = [];
  let pageToken = null;

  do {
    const u = new URL(`${YT_API}/playlistItems`);
    u.searchParams.set("part", "snippet");
    u.searchParams.set("playlistId", playlistId);
    u.searchParams.set("maxResults", "50");
    u.searchParams.set("key", YOUTUBE_API_KEY);
    if (pageToken) u.searchParams.set("pageToken", pageToken);

    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`YouTube playlistItems failed: ${res.status} ${await res.text()}`);

    const json = await res.json();
    for (const it of json.items ?? []) {
      const sn = it.snippet ?? {};
      const vid = sn.resourceId?.videoId;
      if (!vid) continue;

      if (sinceISO && sn.publishedAt && new Date(sn.publishedAt) < new Date(sinceISO)) {
        continue;
      }

      out.push({
        id: `youtube:playlist:${playlistId}:${vid}`,
        title: sn.title ?? "(untitled)",
        url: `https://www.youtube.com/watch?v=${vid}`,
        sourceType: "youtube-playlist",
        publishedAt: sn.publishedAt ?? new Date().toISOString(),
        thumbnail: sn.thumbnails?.high?.url ?? sn.thumbnails?.default?.url ?? null,
        tags: [],
      });
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  return out;
}

/* ───────── RSS ───────── */
async function fetchRssFeed({ id, url, sinceISO }) {
  const feed = await rss.parseURL(url);
  const out = [];
  for (const it of feed.items ?? []) {
    const pub = it.isoDate || it.pubDate || null;
    if (sinceISO && pub && new Date(pub) < new Date(sinceISO)) continue;
    out.push({
      id: `rss:${id}:${Buffer.from(it.link ?? it.guid ?? it.title ?? "").toString("base64url")}`,
      title: it.title ?? "(untitled)",
      url: it.link ?? null,
      sourceType: "rss",
      publishedAt: pub ?? new Date().toISOString(),
      thumbnail: null,
      tags: [],
    });
  }
  return out;
}

/* ───────── Main ───────── */
export async function ingest() {
  const sources = await loadSources();
  const state = await loadState();
  const kb = await loadKnowledge();
  const newItems = [];

  /* Raindrop */
  if (sources.raindrop?.collections?.length) {
    if (!RAINDROP_TOKEN) log("RAINDROP_TOKEN missing; skipping Raindrop");
    for (const c of sources.raindrop.collections ?? []) {
      if (c.mode === "pause") continue;
      const onceKey = `raindrop-${c.id}`;
      if (c.mode === "once" && state.completedOnce[onceKey]) continue;

      const sinceISO =
        c.window ? windowToSinceISO(c.window)
                 : (sources.raindrop.defaultWindow ? windowToSinceISO(sources.raindrop.defaultWindow) : null);

      const raw = await fetchRaindropCollection({ collectionId: c.id, sinceISO });
      for (const it of raw) {
        const item = { ...it, collection: normalizeCollection(c.name ?? it.collection) };
        pushIfNew(kb.items, item, newItems);
      }

      if (c.mode === "once") state.completedOnce[onceKey] = true;
    }
  }

  /* YouTube playlists */
  if (sources.youtube?.playlists?.length) {
    if (!YOUTUBE_API_KEY) log("YOUTUBE_API_KEY missing; skipping YouTube playlists");
    for (const p of sources.youtube.playlists ?? []) {
      if (p.mode === "pause") continue;
      const onceKey = `yt-playlist-${p.id}`;
      if (p.mode === "once" && state.completedOnce[onceKey]) continue;

      const sinceISO =
        p.window ? windowToSinceISO(p.window)
                 : (sources.youtube.defaultWindow ? windowToSinceISO(sources.youtube.defaultWindow) : null);

      const items = await fetchPlaylistItems({ playlistId: p.id, sinceISO });
      for (const it of items) pushIfNew(kb.items, it, newItems);

      if (p.mode === "once") state.completedOnce[onceKey] = true;
    }
  }

  /* YouTube channels */
  if (sources.youtube?.channels?.length) {
    if (!YOUTUBE_API_KEY) log("YOUTUBE_API_KEY missing; skipping YouTube channels");
    for (const ch of sources.youtube.channels ?? []) {
      if (ch.mode === "pause") continue;

      const weeklyKey = `yt-channel-weekly-${ch.handle}`;
      let sinceISO;
      if (ch.mode === "weekly-once") {
        if (state.completedOnce[weeklyKey]) {
          sinceISO = windowToSinceISO(sources.youtube.defaultWindow ?? "1d");
        } else {
          sinceISO = windowToSinceISO("7d");
        }
      } else {
        sinceISO = ch.window ? windowToSinceISO(ch.window) : windowToSinceISO(sources.youtube.defaultWindow ?? "1d");
      }

      const channelId = await resolveChannelIdFromHandle(ch.handle);
      const vids = await fetchChannelVideos({ channelId, sinceISO });
      for (const it of vids) pushIfNew(kb.items, it, newItems);

      if (ch.mode === "weekly-once" && !state.completedOnce[weeklyKey]) {
        state.completedOnce[weeklyKey] = true;
      }
    }
  }

  /* RSS */
  for (const f of sources.rss ?? []) {
    if (f.mode === "pause") continue;
    const onceKey = `rss-${f.id}`;
    if (f.mode === "once" && state.completedOnce[onceKey]) continue;

    const sinceISO = f.window ? windowToSinceISO(f.window) : null;
    try {
      const items = await fetchRssFeed({ id: f.id, url: f.url, sinceISO });
      for (const it of items) pushIfNew(kb.items, it, newItems);
      if (f.mode === "once") state.completedOnce[onceKey] = true;
    } catch (err) {
      log(`RSS fetch failed for ${f.id}`, { error: err.message });
    }
  }

  /* Save */
  state.lastCount = newItems.length;

  if (newItems.length) {
    log(`Ingested ${newItems.length} new items`, { newItems: newItems.length });
    await saveKnowledge(kb);     // updates knowledge.json for the site immediately
  } else {
    log("No new items found this run");
  }

  await saveState(state);
}

/* Run direct */
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
