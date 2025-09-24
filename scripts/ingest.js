import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "ingest-state.json");
const SOURCES_FILE = path.join(ROOT_DIR, "sources.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

/* ------------------ Small utils ------------------ */
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}
async function listDirectories(parent) {
  try { const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter(e=>e.isDirectory()).map(e=>e.name);
  } catch { return []; }
}
function log(msg, ctx={}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}${Object.keys(ctx).length ? " " + JSON.stringify(ctx) : ""}`);
}
function isoFromWindow(windowStr = "1d") {
  const n = parseInt(windowStr, 10) || 1;
  const unit = windowStr.replace(String(n), "").trim().toLowerCase(); // d,w,m
  const msPer = unit === "w" ? 7*864e5 : unit === "m" ? 30*864e5 : 864e5;
  return new Date(Date.now() - n * msPer).toISOString();
}
function uniqBy(arr, keyOf) {
  const seen = new Set(); const out = [];
  for (const it of arr) { const k = keyOf(it); if (k && !seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

/* ------------------ State ------------------ */
async function loadState() { return loadJson(STATE_FILE, { completedOnce: {} }); }
async function saveState(state) { await saveJson(STATE_FILE, state); }

/* ------------------ Raindrop ------------------ */
const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
async function fetchAllRaindropsInCollection(collectionId) {
  if (!RAINDROP_TOKEN) throw new Error("RAINDROP_TOKEN missing");
  const perPage = 100;
  let page = 0, items = [], keepGoing = true;

  while (keepGoing) {
    page += 1;
    const url = `https://api.raindrop.io/rest/v1/raindrops/${collectionId}?perpage=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` }});
    if (!res.ok) throw new Error(`Raindrop ${collectionId} page ${page}: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const batch = json?.items ?? [];
    items = items.concat(batch);
    keepGoing = batch.length === perPage;
  }
  return items.map(x => ({
    canonicalId: `rd:${x._id}`,
    id: `rd:${x._id}`,
    title: x.title || x.domain || "(untitled)",
    url: x.link,
    sourceType: "raindrop",
    publishedAt: x.created,
    thumbnail: x.cover || null,
    tags: Array.isArray(x.tags) ? x.tags : [],
    collection: String(collectionId)
  }));
}

/* ------------------ YouTube ------------------ */
const YT_KEY = process.env.YOUTUBE_API_KEY;
async function ytGetJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube error: ${res.status} ${await res.text()}`);
  return res.json();
}
async function fetchPlaylistItems(playlistId) {
  if (!YT_KEY) throw new Error("YOUTUBE_API_KEY missing");
  const out = [];
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=50&key=${YT_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const json = await ytGetJson(url);
    for (const it of json.items ?? []) {
      const vid = it.contentDetails?.videoId;
      const sn = it.snippet ?? {};
      out.push({
        canonicalId: `yt:${vid}`,
        id: `yt:${vid}`,
        title: sn.title || "(untitled)",
        url: vid ? `https://www.youtube.com/watch?v=${vid}` : null,
        sourceType: "youtube-playlist",
        publishedAt: sn.publishedAt || it.contentDetails?.videoPublishedAt || new Date().toISOString(),
        thumbnail: sn.thumbnails?.default?.url ?? null,
        tags: []
      });
    }
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}
async function resolveChannelIdFromHandle(handle) {
  if (!YT_KEY) throw new Error("YOUTUBE_API_KEY missing");
  // Try the “search channels by query” approach (handles resolve fine)
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(handle)}&key=${YT_KEY}`;
  const json = await ytGetJson(url);
  const id = json.items?.[0]?.id?.channelId;
  if (!id) throw new Error(`Unable to resolve channel for handle: ${handle}`);
  return id;
}
async function fetchChannelItems(handle, publishedAfterISO) {
  if (!YT_KEY) throw new Error("YOUTUBE_API_KEY missing");
  const channelId = await resolveChannelIdFromHandle(handle);
  const out = [];
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&channelId=${channelId}&order=date&maxResults=50&key=${YT_KEY}` +
      (publishedAfterISO ? `&publishedAfter=${encodeURIComponent(publishedAfterISO)}` : "") +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const json = await ytGetJson(url);
    for (const it of json.items ?? []) {
      const vid = it.id?.videoId;
      const sn = it.snippet ?? {};
      out.push({
        canonicalId: `yt:${vid}`,
        id: `yt:${vid}`,
        title: sn.title || "(untitled)",
        url: vid ? `https://www.youtube.com/watch?v=${vid}` : null,
        sourceType: "youtube-channel",
        publishedAt: sn.publishedAt || new Date().toISOString(),
        thumbnail: sn.thumbnails?.default?.url ?? null,
        tags: []
      });
    }
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/* ------------------ Curated run helper ------------------ */
async function createCuratedRun(items) {
  const dayDir = new Date().toISOString().slice(0, 10);
  const stampDir = `${Date.now()}`;
  const itemsPath = path.join(CURATED_ROOT, dayDir, stampDir, "items.json");
  await saveJson(itemsPath, { generatedAt: new Date().toISOString(), items });
  return { dayDir, stampDir, itemsPath };
}

/* ------------------ Main ingest ------------------ */
export async function ingest() {
  const sources = await loadJson(SOURCES_FILE, null);
  if (!sources) { log("No sources.json found; skip ingest"); return; }
  const state = await loadState();
  const kb = await loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });

  let newItems = [];

  /* ---- Raindrop collections ---- */
  for (const c of (sources.raindrop?.collections ?? [])) {
    if (c.mode === "pause") continue;
    const onceKey = `raindrop-${c.id}`;
    if (c.mode === "once" && state.completedOnce[onceKey]) continue;

    const all = await fetchAllRaindropsInCollection(c.id);
    let pulled = all;

    // If not the initial once-pull, filter to last window (daily by default)
    if (state.completedOnce[onceKey] || c.mode !== "once") {
      const since = isoFromWindow(sources.raindrop?.defaultWindow || "1d");
      pulled = all.filter(x => !x.publishedAt || new Date(x.publishedAt) >= new Date(since));
    }

    newItems = newItems.concat(pulled);
    if (c.mode === "once") state.completedOnce[onceKey] = true;
  }

  /* ---- YouTube playlists ---- */
  for (const p of (sources.youtube?.playlists ?? [])) {
    if (p.mode === "pause") continue;
    const onceKey = `yt-playlist-${p.id}`;
    if (p.mode === "once" && state.completedOnce[onceKey]) continue;

    const items = await fetchPlaylistItems(p.id);
    // If this isn’t the first time, just take recent entries (playlists rarely need daily filter,
    // but we keep it small: use last 7 days when not once)
    const filtered = (p.mode === "once" && !state.completedOnce[onceKey])
      ? items
      : items.filter(x => new Date(x.publishedAt) >= new Date(isoFromWindow("7d")));

    newItems = newItems.concat(filtered);
    if (p.mode === "once") state.completedOnce[onceKey] = true;
  }

  /* ---- YouTube channels ---- */
  for (const ch of (sources.youtube?.channels ?? [])) {
    if (ch.mode === "pause") continue;
    const weeklyKey = `yt-channel-weekly-${ch.handle}`;
    let since = sources.youtube?.defaultWindow || "1d";

    if (!state.completedOnce[weeklyKey] && ch.mode === "weekly-once") {
      since = "7d"; // first run: pull last 7d
      state.completedOnce[weeklyKey] = true; // next runs fall back to daily
    }

    const items = await fetchChannelItems(ch.handle, isoFromWindow(since));
    newItems = newItems.concat(items);
  }

  // Dedup by canonicalId (or URL if missing)
  newItems = uniqBy(newItems, it => it.canonicalId || it.url);

  if (newItems.length === 0) {
    log("Ingest found no new items; still writing empty curated run for downstream steps.");
  } else {
    log("Ingested new items", { count: newItems.length });
  }

  // Update knowledge.json (append new, dedup)
  const merged = uniqBy([...newItems, ...kb.items], it => it.canonicalId || it.url);
  await saveJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: merged });

  // Always write a curated run with *just* the new items for this run
  const run = await createCuratedRun(newItems);

  // Persist state
  await saveState(state);

  log("Ingest complete", { curatedRun: `${run.dayDir}/${run.stampDir}`, newItems: newItems.length });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch(err => { console.error("Ingest failed", err); process.exitCode = 1; });
}
