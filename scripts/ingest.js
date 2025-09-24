import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "cache");
const CURATED = path.join(DATA, "curated");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const SOURCES_FILE = path.join(ROOT, "sources.json");
const STATE_FILE = path.join(CACHE, "ingest-state.json");
const STATS_FILE = path.join(CACHE, "ingest-stats.json");

function log(m, c = {}) { console.log(`[${new Date().toISOString()}] ${m}`, Object.keys(c).length?c:""); }
async function ensureDir(p){ await fs.mkdir(p,{recursive:true}); }
async function loadJson(p, fb){ try { return JSON.parse(await fs.readFile(p,"utf8")); } catch { return fb; } }
async function saveJson(p, v){ await ensureDir(path.dirname(p)); await fs.writeFile(p, JSON.stringify(v,null,2), "utf8"); }

function nowStamp(){ return Date.now().toString(); }
function dayDir(){ return new Date().toISOString().slice(0,10); }

function windowToISO(windowStr) {
  if (!windowStr) return null;
  const m = /^(\d+)([dhw])$/.exec(windowStr);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === "d" ? n*86400000 : unit==="h" ? n*3600000 : n*604800000;
  return new Date(Date.now() - ms).toISOString();
}

/* ---------- RAINDROP ---------- */
async function raindropFetchCollectionItems(collectionId, token, perPage = 100) {
  let page = 0;
  const results = [];
  while (true) {
    const url = `https://api.raindrop.io/rest/v1/raindrops/${collectionId}?perpage=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Raindrop ${res.status} ${await res.text()}`);
    const json = await res.json();
    const items = json.items ?? [];
    for (const it of items) {
      results.push({
        id: `rd-${it._id}`,
        canonicalId: `rd-${it._id}`,
        title: it.title ?? it.domain ?? "(untitled)",
        url: it.link,
        sourceType: "raindrop",
        publishedAt: (it.created || it.lastUpdate || new Date().toISOString()),
        tags: it.tags || [],
        collection: String(collectionId)
      });
    }
    if (items.length < perPage) break;
    page += 1;
  }
  return results;
}

/* ---------- YOUTUBE ---------- */
const YT_KEY = process.env.YOUTUBE_API_KEY;
async function ytResolveHandle(handle) {
  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${YT_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube resolve handle ${res.status} ${await res.text()}`);
  const json = await res.json();
  const id = json.items?.[0]?.id;
  if (!id) throw new Error(`No channelId for handle ${handle}`);
  return id;
}
async function ytSearchChannelVideos(channelId, publishedAfterISO) {
  const items = [];
  let pageToken = "";
  while (true) {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("channelId", channelId);
    url.searchParams.set("type", "video");
    url.searchParams.set("order", "date");
    if (publishedAfterISO) url.searchParams.set("publishedAfter", publishedAfterISO);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("key", YT_KEY);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube search ${res.status} ${await res.text()}`);
    const json = await res.json();
    for (const it of json.items ?? []) {
      items.push({
        id: `yt-${it.id.videoId}`,
        canonicalId: `yt-${it.id.videoId}`,
        title: it.snippet.title,
        url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
        sourceType: "youtube-channel",
        publishedAt: it.snippet.publishedAt,
        channelId
      });
    }
    pageToken = json.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return items;
}
async function ytPlaylistItems(playlistId) {
  const items = [];
  let pageToken = "";
  while (true) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("key", YT_KEY);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube playlistItems ${res.status} ${await res.text()}`);
    const json = await res.json();
    for (const it of json.items ?? []) {
      const vid = it.contentDetails?.videoId;
      items.push({
        id: `yt-${vid}`,
        canonicalId: `yt-${vid}`,
        title: it.snippet.title,
        url: `https://www.youtube.com/watch?v=${vid}`,
        sourceType: "youtube-playlist",
        publishedAt: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt
      });
    }
    pageToken = json.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return items;
}

/* ---------- MAIN ---------- */
export async function ingest() {
  const sources = await loadJson(SOURCES_FILE, null);
  if (!sources) { log("No sources.json found; skip ingest"); return; }

  const state = await loadJson(STATE_FILE, { completedOnce: {} });
  const kb = await loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });

  const day = dayDir();
  const stamp = nowStamp();
  const runDir = path.join(CURATED, day, stamp);
  await ensureDir(runDir);

  const addedThisRun = [];
  const already = new Set(kb.items.map(i => i.canonicalId || i.id));

  // ---- Raindrop (first-run once / daily fallback after) ----
  if (sources.raindrop?.collections?.length) {
    const token = process.env.RAINDROP_TOKEN;
    if (!token) log("RAINDROP_TOKEN missing; skipping Raindrop");
    else {
      for (const c of sources.raindrop.collections) {
        if (c.mode === "pause") continue;
        const onceKey = `raindrop-${c.id}`;
        if (c.mode === "once" && state.completedOnce[onceKey]) continue;

        const items = await raindropFetchCollectionItems(c.id, token);
        for (const it of items) {
          if (already.has(it.canonicalId)) continue;
          kb.items.push(it);
          addedThisRun.push(it);
          already.add(it.canonicalId);
        }
        if (c.mode === "once") state.completedOnce[onceKey] = true;
      }
    }
  }

  // ---- YouTube playlists ----
  if (sources.youtube?.playlists?.length) {
    if (!YT_KEY) log("YOUTUBE_API_KEY missing; skipping YouTube playlists");
    else {
      for (const p of sources.youtube.playlists) {
        if (p.mode === "pause") continue;
        const onceKey = `yt-playlist-${p.id}`;
        if (p.mode === "once" && state.completedOnce[onceKey]) continue;

        const items = await ytPlaylistItems(p.id);
        for (const it of items) {
          if (already.has(it.canonicalId)) continue;
          kb.items.push(it);
          addedThisRun.push(it);
          already.add(it.canonicalId);
        }
        if (p.mode === "once") state.completedOnce[onceKey] = true;
      }
    }
  }

  // ---- YouTube channels (weekly-once then daily 24h) ----
  if (sources.youtube?.channels?.length) {
    if (!YT_KEY) log("YOUTUBE_API_KEY missing; skipping YouTube channels");
    else {
      for (const c of sources.youtube.channels) {
        if (c.mode === "pause") continue;

        const weeklyKey = `yt-weekly-${c.handle}`;
        let windowISO;

        if (c.mode === "weekly-once" && !state.completedOnce[weeklyKey]) {
          windowISO = windowToISO("7d");
        } else {
          // after first weekly pass, or if not weekly-once → daily window
          const w = sources.youtube.defaultWindow || "1d";
          windowISO = windowToISO(w);
        }

        const channelId = await ytResolveHandle(c.handle);
        const items = await ytSearchChannelVideos(channelId, windowISO);
        for (const it of items) {
          if (already.has(it.canonicalId)) continue;
          kb.items.push(it);
          addedThisRun.push(it);
          already.add(it.canonicalId);
        }
        if (c.mode === "weekly-once" && !state.completedOnce[weeklyKey]) state.completedOnce[weeklyKey] = true;
      }
    }
  }

  // ---- RSS (paused per your sources) ----
  // left intact for future use; respects "pause" and "once" the same way.

  // Save incremental outputs
  if (addedThisRun.length) {
    await saveJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: kb.items });
    await saveJson(path.join(runDir, "items.json"), { generatedAt: new Date().toISOString(), items: addedThisRun });
    await saveJson(STATS_FILE, { count: addedThisRun.length });
    log(`Ingest added ${addedThisRun.length} items`, { curatedRun: path.relative(ROOT, runDir) });
  } else {
    // still write an empty run marker so downstream steps keep going
    await saveJson(path.join(runDir, "items.json"), { generatedAt: new Date().toISOString(), items: [] });
    await saveJson(STATS_FILE, { count: 0 });
    log("No new items found this run");
  }

  await saveJson(STATE_FILE, state);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((e) => {
    console.error("Ingest failed", e);
    process.exitCode = 1;
  });
}
