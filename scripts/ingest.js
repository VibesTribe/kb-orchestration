// scripts/ingest.js
// Real ingestion of Raindrop collections, YouTube playlists, YouTube channels
// with incremental checkpointing + per-item upstream push to prevent data loss.
// Safety Net Plan added:
//  - Bootstrap mode with retry tracking for weekly-once sources
//  - Per-channel error isolation (already present; enhanced with status fields)
//  - Skip-duplicates via seenIds + global ID check (unchanged core behavior)
//  - Exponential backoff via skipUntil to avoid daily spam on permanent errors
//  - Success tracking (lastSuccess) vs lastError; do not block other sources

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { loadJson, saveJsonCheckpoint, ensureDir } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";

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
  const state = await loadJson(STATE_FILE, {
    sources: {}, // per-source metadata
  });
  if (!state.sources) state.sources = {};
  return state;
}

async function saveState(state) {
  await saveJsonCheckpoint(STATE_FILE, state);
}

// ------- CONFIG LOADING (flexible parser) -------

async function loadSourcesConfig() {
  const cfg = await loadJson(CONFIG_FILE, null);
  if (!cfg) {
    throw new Error("Missing or invalid config/sources.json");
  }
  // Expected flexible shapes:
  // {
  //   "raindrop": { "collections": [ { "id" or "collectionId": 123, "mode": "once|daily|weekly-once", "defaultWindow": 7 } ] },
  //   "youtube": { "playlists": [ { "id" or "playlistId": "PL..." } ], "channels": [ { "id" or "channelId": "UC...", "defaultWindow": 7, "mode": "weekly-once" } ] }
  // }
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
        defaultWindow: Number(c.defaultWindow ?? 7),
        name: c.name ?? `raindrop-${c.collectionId ?? c.id}`,
      });
    }
  }
  if (Array.isArray(youtube.playlists)) {
    for (const p of youtube.playlists) {
      out.youtubePlaylists.push({
        id: p.playlistId ?? p.id,
        mode: p.mode ?? "once",
        defaultWindow: Number(p.defaultWindow ?? 9999), // playlists are often one-time full pulls
        name: p.name ?? `yt-playlist-${p.playlistId ?? p.id}`,
      });
    }
  }
  if (Array.isArray(youtube.channels)) {
    for (const ch of youtube.channels) {
      out.youtubeChannels.push({
        id: ch.channelId ?? ch.id,
        mode: ch.mode ?? "weekly-once",
        defaultWindow: Number(ch.defaultWindow ?? 7),
        name: ch.name ?? `yt-channel-${ch.channelId ?? ch.id}`,
      });
    }
  }
  return out;
}

// ------- Safety Net helpers -------

function getOrInitSourceState(state, key, initialMode) {
  const existing = state.sources[key];
  if (existing) return existing;
  // bootstrapPending: for "weekly-once", keep retrying once-per-run until a first successful call
  const s = {
    lastRun: null,            // set only on success
    lastSuccess: null,        // success timestamp
    lastError: null,          // last error timestamp
    failures: 0,              // consecutive failure count
    skipUntil: null,          // ISO date string (YYYY-MM-DD) to skip retries until
    bootstrapPending: initialMode === "weekly-once", // true until first success
    seenIds: {},              // dedupe per-source
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

function addDaysISO(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function markFailure(srcState) {
  srcState.lastError = nowIso();
  srcState.failures = (srcState.failures || 0) + 1;
  // Exponential-ish backoff: 1d, 2d, 3d, ... max 7d
  const delay = Math.min(srcState.failures, 7);
  srcState.skipUntil = addDaysISO(new Date(), delay);
}

// ------- RAINDROP -------

async function fetchRaindropCollectionItems(collectionId, { sinceDate, page = 0, perPage = 50 } = {}) {
  // API: https://api.raindrop.io/rest/v1/raindrops/{collection}?page=0&perpage=50
  const url = new URL(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("perpage", String(perPage));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Raindrop fetch failed: ${res.status} ${t}`);
  }
  const json = await res.json(); // { items: [...], count, ... }
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

async function ingestRaindropCollection(source, knowledge, state) {
  if (!RAINDROP_TOKEN) {
    log("RAINDROP_TOKEN missing; skipping raindrop collection", { collection: source.id });
    return;
  }

  const sKey = `raindrop:${source.id}`;
  const srcState = getOrInitSourceState(state, sKey, source.mode);

  if (shouldSkipByBackoff(srcState)) {
    log("Skip by backoff", { source: sKey, skipUntil: srcState.skipUntil });
    return;
  }

  // Weekly throttle — EXCEPT while bootstrapping
  if (source.mode === "weekly-once" && !srcState.bootstrapPending && !isWeeklyWindow(srcState.lastRun)) {
    log("Skip (weekly-once window not reached)", { source: sKey });
    return;
  }

  const sinceDate = daysAgo(source.defaultWindow || 7);
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

        // global dedupe too
        if (!knowledge.items.find((k) => k.id === item.id)) {
          knowledge.items.push(item);
          await saveKnowledge(knowledge); // local + pushUpdate
          added++;
        }

        srcState.seenIds[id] = true;
      }

      if (!hasMore) break;
      page += 1;
    }

    markSuccess(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
    log("Raindrop collection ingested", { collectionId: source.id, added, bootstrapCleared: !srcState.bootstrapPending });
  } catch (e) {
    log("Raindrop collection error", { id: source.id, error: e.message });
    markFailure(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
  }
}

// ------- YOUTUBE -------

async function fetchYouTubePlaylistItems(playlistId, pageToken = null) {
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("key", YOUTUBE_API_KEY);
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`YouTube playlist fetch failed: ${res.status} ${t}`);
  }
  return res.json(); // { items, nextPageToken, ... }
}

async function ingestYouTubePlaylist(source, knowledge, state) {
  if (!YOUTUBE_API_KEY) {
    log("YOUTUBE_API_KEY missing; skipping youtube playlist", { playlist: source.id });
    return;
  }

  const sKey = `yt:playlist:${source.id}`;
  const srcState = getOrInitSourceState(state, sKey, source.mode);

  if (shouldSkipByBackoff(srcState)) {
    log("Skip by backoff", { source: sKey, skipUntil: srcState.skipUntil });
    return;
  }

  // For 'once', if we've ever run successfully, skip
  if (source.mode === "once" && srcState.lastSuccess) {
    log("Skip (once already succeeded)", { source: sKey });
    return;
  }

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

        if (!knowledge.items.find((k) => k.id === item.id)) {
          knowledge.items.push(item);
          await saveKnowledge(knowledge); // local + pushUpdate
          added++;
        }

        srcState.seenIds[videoId] = true;
      }
      pageToken = json.nextPageToken || null;
    } while (pageToken);

    markSuccess(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
    log("YouTube playlist ingested", { playlistId: source.id, added, bootstrapCleared: !srcState.bootstrapPending });
  } catch (e) {
    log("YouTube playlist error", { id: source.id, error: e.message });
    markFailure(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
  }
}

async function fetchYouTubeChannelUploads(channelId, publishedAfterIso) {
  // Using search.list for channel + time window (publishedAfter)
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("order", "date");
  url.searchParams.set("type", "video");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  if (publishedAfterIso) url.searchParams.set("publishedAfter", publishedAfterIso);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`YouTube channel fetch failed: ${res.status} ${t}`);
  }
  return res.json(); // { items, nextPageToken? ... }
}

async function ingestYouTubeChannel(source, knowledge, state) {
  if (!YOUTUBE_API_KEY) {
    log("YOUTUBE_API_KEY missing; skipping youtube channel", { channel: source.id });
    return;
  }

  const sKey = `yt:channel:${source.id}`;
  const srcState = getOrInitSourceState(state, sKey, source.mode);

  if (shouldSkipByBackoff(srcState)) {
    log("Skip by backoff", { source: sKey, skipUntil: srcState.skipUntil });
    return;
  }

  // Weekly throttle — EXCEPT while bootstrapping
  if (source.mode === "weekly-once" && !srcState.bootstrapPending && !isWeeklyWindow(srcState.lastRun)) {
    log("Skip (weekly-once window not reached)", { source: sKey });
    return;
  }

  const windowDays = source.defaultWindow || 7;
  const afterIso = daysAgo(windowDays).toISOString();

  let pageToken = null;
  let added = 0;

  try {
    // Keep the paging style close to what you had (don’t over-change working code)
    do {
      const json = await fetchYouTubeChannelUploads(source.id, afterIso);
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

        if (!knowledge.items.find((k) => k.id === item.id)) {
          knowledge.items.push(item);
          await saveKnowledge(knowledge); // local + pushUpdate
          added++;
        }

        srcState.seenIds[videoId] = true;
      }

      pageToken = json.nextPageToken || null;
      if (pageToken) {
        // attempt next page (preserve your existing pattern)
        const url = new URL("https://www.googleapis.com/youtube/v3/search");
        url.searchParams.set("part", "snippet");
        url.searchParams.set("channelId", source.id);
        url.searchParams.set("maxResults", "50");
        url.searchParams.set("order", "date");
        url.searchParams.set("type", "video");
        url.searchParams.set("key", YOUTUBE_API_KEY);
        url.searchParams.set("publishedAfter", afterIso);
        url.searchParams.set("pageToken", pageToken);
        const res = await fetch(url.toString());
        if (!res.ok) {
          log("YouTube channel page fetch failed, stopping pagination", { channelId: source.id, status: res.status });
          pageToken = null;
        } else {
          const nxt = await res.json();
          // Merge items & carry nextPageToken forward
          json.items = (json.items || []).concat(nxt.items || []);
          pageToken = nxt.nextPageToken || null;
        }
      }
    } while (pageToken);

    markSuccess(srcState);
    state.sources[sKey] = srcState;
    await saveState(state);
    log("YouTube channel ingested", { channelId: source.id, added, bootstrapCleared: !srcState.bootstrapPending });
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

  // Load sources, state, knowledge
  const sources = await loadSourcesConfig();
  const state = await loadState();
  const knowledge = await loadKnowledge();

  // RAINDROP collections
  for (const col of sources.raindropCollections) {
    try {
      await ingestRaindropCollection(col, knowledge, state);
    } catch (e) {
      // Per-source isolation
      log("Raindrop collection error (outer)", { id: col.id, error: e.message });
    }
  }

  // YT playlists
  for (const pl of sources.youtubePlaylists) {
    try {
      await ingestYouTubePlaylist(pl, knowledge, state);
    } catch (e) {
      log("YouTube playlist error (outer)", { id: pl.id, error: e.message });
    }
  }

  // YT channels
  for (const ch of sources.youtubeChannels) {
    try {
      await ingestYouTubeChannel(ch, knowledge, state);
    } catch (e) {
      log("YouTube channel error (outer)", { id: ch.id, error: e.message });
    }
  }

  log("Ingest step complete", { total: knowledge.items.length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest step failed", err);
    process.exit(1);
  });
}
