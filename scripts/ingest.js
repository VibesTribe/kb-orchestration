// scripts/ingest.js
// Ingest Raindrop collections, YouTube playlists, YouTube channels
// with incremental checkpointing + per-item upstream push to prevent data loss.
//
// Idempotency & Safety:
//  - Strict dedupe on both ID and URL against knowledge.json (source of truth)
//  - Per-source seenIds persisted (state.json) to avoid refetch churn
//  - Never truncates knowledge.json
//  - Default 24h windows (unless overridden in sources.json)
//  - Validate channel/playlist IDs before calling APIs
//
// Sync behavior:
//  - After each item append, save knowledge.json and push upstream immediately

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { loadJson, saveJsonCheckpoint, ensureDir } from "./lib/utils.js";
import { pushUpdate, pullKnowledge } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA, "cache");
const STATE_FILE = path.join(CACHE_DIR, "state.json");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const CONFIG_FILE = path.join(ROOT, "config", "sources.json");

const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

function nowIso() {
  return new Date().toISOString();
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function isWeeklyWindow(lastRunIso) {
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - last.getTime() >= oneWeek;
}

async function saveKnowledge(knowledge) {
  await ensureDir(path.dirname(KNOWLEDGE_FILE));
  await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
  await pushUpdate(KNOWLEDGE_FILE, "knowledge.json", "Incremental ingest update");
}

async function loadKnowledge() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items)) knowledge.items = [];
  return knowledge;
}

async function loadState() {
  await ensureDir(CACHE_DIR);
  const state = await loadJson(STATE_FILE, { sources: {} });
  if (!state.sources) state.sources = {};
  return state;
}

async function saveState(state) {
  await saveJsonCheckpoint(STATE_FILE, state);
}

// ------- CONFIG LOADING -------

async function loadSourcesConfig() {
  const cfg = await loadJson(CONFIG_FILE, null);
  if (!cfg) throw new Error("Missing or invalid config/sources.json");

  const raindrop = cfg.raindrop || {};
  const youtube = cfg.youtube || {};

  const out = {
    raindropCollections: [],
    youtubePlaylists: [],
    youtubeChannels: [],
  };

  if (Array.isArray(raindrop.collections)) {
    for (const c of raindrop.collections) {
      out.raindropCollections.push({
        id: c.collectionId ?? c.id,
        mode: c.mode ?? "daily",
        defaultWindow: Number(c.defaultWindow ?? 1), // 24h default
        name: c.name ?? `raindrop-${c.collectionId ?? c.id}`,
      });
    }
  }

  if (Array.isArray(youtube.playlists)) {
    for (const p of youtube.playlists) {
      out.youtubePlaylists.push({
        id: p.playlistId ?? p.id,
        mode: p.mode ?? "once",
        defaultWindow: Number(p.defaultWindow ?? 1),
        name: p.name ?? `yt-playlist-${p.playlistId ?? p.id}`,
      });
    }
  }

  if (Array.isArray(youtube.channels)) {
    for (const ch of youtube.channels) {
      out.youtubeChannels.push({
        id: ch.channelId ?? ch.id,
        mode: ch.mode ?? "daily",
        defaultWindow: Number(ch.defaultWindow ?? 1),
        name: ch.name ?? `yt-channel-${ch.channelId ?? ch.id}`,
      });
    }
  }

  return out;
}

// ------- SAFETY NET -------

function getOrInitSourceState(state, key, initialMode) {
  if (state.sources[key]) return state.sources[key];
  const s = {
    lastRun: null,
    lastSuccess: null,
    lastError: null,
    failures: 0,
    skipUntil: null,
    bootstrapPending: initialMode === "weekly-once",
    seenIds: {},
  };
  state.sources[key] = s;
  return s;
}

function shouldSkipByBackoff(srcState) {
  if (!srcState.skipUntil) return false;
  const today = new Date().toISOString().slice(0, 10);
  return today < srcState.skipUntil;
}

function markSuccess(srcState) {
  srcState.lastRun = nowIso();
  srcState.lastSuccess = srcState.lastRun;
  srcState.lastError = null;
  srcState.failures = 0;
  srcState.skipUntil = null;
  if (srcState.bootstrapPending) srcState.bootstrapPending = false;
}

function markFailure(srcState) {
  srcState.lastError = nowIso();
  srcState.failures = (srcState.failures || 0) + 1;
  const delay = Math.min(srcState.failures, 7);
  const d = new Date();
  d.setDate(d.getDate() + delay);
  srcState.skipUntil = d.toISOString().slice(0, 10);
}

// ------- HELPERS -------

function isValidChannelId(id) {
  return typeof id === "string" && id.startsWith("UC") && id.length >= 22;
}
function isValidPlaylistId(id) {
  return typeof id === "string" && id.startsWith("PL") && id.length >= 16;
}

// Build in-memory indexes for fast, stable dedupe across runs
function buildDedupeIndexes(knowledge) {
  const byId = new Set();
  const byUrl = new Set();
  for (const it of knowledge.items) {
    if (it?.id) byId.add(String(it.id));
    if (it?.url) byUrl.add(String(it.url));
  }
  return { byId, byUrl };
}

function isDuplicate(indexes, item) {
  return (item.id && indexes.byId.has(String(item.id))) ||
         (item.url && indexes.byUrl.has(String(item.url)));
}

// ------- RAINDROP -------

async function fetchRaindropCollectionItems(collectionId, { sinceDate, page = 0, perPage = 50 } = {}) {
  const url = new URL(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("perpage", String(perPage));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Raindrop fetch failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  let items = Array.isArray(json.items) ? json.items : [];
  if (sinceDate) {
    const cut = sinceDate.getTime();
    items = items.filter((it) => {
      const d = it.created || it.lastUpdate || it.createdAt || it._created;
      return d ? new Date(d).getTime() >= cut : true;
    });
  }
  return { items, hasMore: items.length === perPage };
}

async function ingestRaindropCollection(source, knowledge, indexes, state) {
  if (!RAINDROP_TOKEN) {
    log("RAINDROP_TOKEN missing; skipping raindrop collection", { collection: source.id });
    return;
  }

  const sKey = `raindrop:${source.id}`;
  const srcState = getOrInitSourceState(state, sKey, source.mode);
  if (shouldSkipByBackoff(srcState)) return;

  const sinceDate = daysAgo(source.defaultWindow);
  let page = 0;
  let added = 0;

  try {
    while (true) {
      const { items, hasMore } = await fetchRaindropCollectionItems(source.id, { sinceDate, page });
      if (!items.length) break;

      for (const it of items) {
        const id = String(it._id ?? it._idStr ?? it.link ?? `${source.id}-${it.title}-${it.created}`);
        if (srcState.seenIds[id]) continue;

        const item = {
          id: `raindrop:${id}`,
          title: it.title || it.excerpt || "(untitled)",
          url: it.link || it.url || null,
          sourceType: "raindrop",
          collectionId: source.id,
          createdAt: it.created || it.createdAt || null,
          ingestedAt: nowIso(),
        };

        // Strict dedupe against knowledge.json
        if (!isDuplicate(indexes, item)) {
          knowledge.items.push(item);
          if (item.id) indexes.byId.add(String(item.id));
          if (item.url) indexes.byUrl.add(String(item.url));
          await saveKnowledge(knowledge);
          added++;
        }

        srcState.seenIds[id] = true;
      }

      if (!hasMore) break;
      page++;
    }

    markSuccess(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
    log("Raindrop ingested", { collectionId: source.id, added });
  } catch (e) {
    log("Raindrop error", { id: source.id, error: e.message });
    markFailure(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
  }
}

// ------- YOUTUBE PLAYLIST -------

async function fetchYouTubePlaylistItems(playlistId, pageToken = null) {
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("key", YOUTUBE_API_KEY);
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube playlist fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ingestYouTubePlaylist(source, knowledge, indexes, state) {
  if (!YOUTUBE_API_KEY) return;
  if (!isValidPlaylistId(source.id)) {
    log("Invalid playlist ID; skipping", { id: source.id });
    return;
  }

  const sKey = `yt:playlist:${source.id}`;
  const srcState = getOrInitSourceState(state, sKey, source.mode);
  if (shouldSkipByBackoff(srcState)) return;
  if (source.mode === "once" && srcState.lastSuccess) return;

  let pageToken = null;
  let added = 0;

  try {
    do {
      const json = await fetchYouTubePlaylistItems(source.id, pageToken);
      for (const it of json.items || []) {
        const videoId = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
        if (!videoId) continue;
        if (srcState.seenIds[videoId]) continue;

        const snippet = it.snippet || {};
        const item = {
          id: `youtube:video:${videoId}`,
          title: snippet.title || "(untitled)",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          sourceType: "youtube",
          playlistId: source.id,
          publishedAt: snippet.publishedAt || null,
          ingestedAt: nowIso(),
        };

        if (!isDuplicate(indexes, item)) {
          knowledge.items.push(item);
          indexes.byId.add(String(item.id));
          indexes.byUrl.add(String(item.url));
          await saveKnowledge(knowledge);
          added++;
        }

        srcState.seenIds[videoId] = true;
      }
      pageToken = json.nextPageToken || null;
    } while (pageToken);

    markSuccess(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
    log("YouTube playlist ingested", { playlistId: source.id, added });
  } catch (e) {
    log("YouTube playlist error", { id: source.id, error: e.message });
    markFailure(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
  }
}

// ------- YOUTUBE CHANNEL -------

async function fetchYouTubeChannelUploads(channelId, publishedAfterIso, pageToken = null) {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("order", "date");
  url.searchParams.set("type", "video");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  if (publishedAfterIso) url.searchParams.set("publishedAfter", publishedAfterIso);
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube channel fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ingestYouTubeChannel(source, knowledge, indexes, state) {
  if (!YOUTUBE_API_KEY) return;
  if (!isValidChannelId(source.id)) {
    log("Invalid channel ID; skipping", { id: source.id });
    return;
  }

  const sKey = `yt:channel:${source.id}`;
  const srcState = getOrInitSourceState(state, sKey, source.mode);
  if (shouldSkipByBackoff(srcState)) return;
  if (source.mode === "weekly-once" && !srcState.bootstrapPending && !isWeeklyWindow(srcState.lastRun)) return;

  const afterIso = daysAgo(source.defaultWindow).toISOString();
  let pageToken = null;
  let added = 0;

  try {
    do {
      const json = await fetchYouTubeChannelUploads(source.id, afterIso, pageToken);
      for (const it of json.items || []) {
        const videoId = it.id?.videoId;
        if (!videoId) continue;
        if (srcState.seenIds[videoId]) continue;

        const snippet = it.snippet || {};
        const item = {
          id: `youtube:video:${videoId}`,
          title: snippet.title || "(untitled)",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          sourceType: "youtube",
          channelId: source.id,
          publishedAt: snippet.publishedAt || null,
          ingestedAt: nowIso(),
        };

        if (!isDuplicate(indexes, item)) {
          knowledge.items.push(item);
          indexes.byId.add(String(item.id));
          indexes.byUrl.add(String(item.url));
          await saveKnowledge(knowledge);
          added++;
        }

        srcState.seenIds[videoId] = true;
      }
      pageToken = json.nextPageToken || null;
    } while (pageToken);

    markSuccess(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
    log("YouTube channel ingested", { channelId: source.id, added });
  } catch (e) {
    log("YouTube channel error", { id: source.id, error: e.message });
    markFailure(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
  }
}

// ------- MAIN -------

export async function ingest() {
  log("Starting ingest...");

  // 🔒 Pull canonical knowledge.json first to avoid accidental shrink
  try {
    await pullKnowledge();
  } catch (e) {
    log("pullKnowledge failed; continuing with local knowledge.json", { error: e.message });
  }

  const sources = await loadSourcesConfig();
  const state = await loadState();
  const knowledge = await loadKnowledge();
  const indexes = buildDedupeIndexes(knowledge); // <-- source-of-truth dedupe

  // Order: Raindrop → Playlists → Channels
  for (const col of sources.raindropCollections) {
    try { await ingestRaindropCollection(col, knowledge, indexes, state); }
    catch (e) { log("Raindrop collection error", { id: col.id, error: e.message }); }
  }

  for (const pl of sources.youtubePlaylists) {
    try { await ingestYouTubePlaylist(pl, knowledge, indexes, state); }
    catch (e) { log("YouTube playlist error", { id: pl.id, error: e.message }); }
  }

  for (const ch of sources.youtubeChannels) {
    try { await ingestYouTubeChannel(ch, knowledge, indexes, state); }
    catch (e) { log("YouTube channel error", { id: ch.id, error: e.message }); }
  }

  log("Ingest step complete", { total: knowledge.items.length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest step failed", err);
    process.exit(1);
  });
}
