import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import crypto from "node:crypto";
import { ensureDir as ensureDirUtils, loadJson, saveJsonCheckpoint } from "./utils.js";

/** ─────────────────────────────────────────────────────────────────────────────
 *  Paths & setup
 *  ────────────────────────────────────────────────────────────────────────────*/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// Config & cache
const CONFIG_PATH = path.join(ROOT_DIR, "config", "sources.json");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const META_PATH = path.join(CACHE_ROOT, "ingest-meta.json");
const HANDLE_CACHE_PATH = path.join(CACHE_ROOT, "youtube-handles.json");

// Knowledge store (site source of truth)
const DEFAULT_KNOWLEDGE_JSON_PATH = path.resolve(ROOT_DIR, "..", "knowledgebase", "knowledge.json");
const KNOWLEDGE_JSON_PATH = process.env.KNOWLEDGE_JSON_PATH || DEFAULT_KNOWLEDGE_JSON_PATH;

// Run stamp (for optional local raw dumps, if you want them)
const DATA_ROOT = path.join(ROOT_DIR, "data", "raw");
const NOW = new Date();
const RUN_STAMP = NOW.toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(DATA_ROOT, NOW.toISOString().slice(0, 10), RUN_STAMP);

// External tokens
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;

const parser = new Parser();

/** ─────────────────────────────────────────────────────────────────────────────
 *  Logging
 *  ────────────────────────────────────────────────────────────────────────────*/
function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  FS helpers (wrap your utils ensureDir to avoid name clash)
 *  ────────────────────────────────────────────────────────────────────────────*/
async function ensureDir(p) {
  await ensureDirUtils(p);
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Safe fetch JSON
 *  ────────────────────────────────────────────────────────────────────────────*/
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text}`);
  }
  return res.json();
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Meta (per-source last run & flags)
 *  ────────────────────────────────────────────────────────────────────────────*/
async function loadMeta() {
  try {
    const raw = await fs.readFile(META_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { sources: {} };
  }
}

async function saveMeta(meta) {
  await ensureDir(CACHE_ROOT);
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2), "utf8");
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Knowledge store (site data)
 *  Structure: { items: [], digests: [], runs: [] }
 *  We incrementally upsert into items[] after every new ingestion item.
 *  ────────────────────────────────────────────────────────────────────────────*/
async function loadKnowledge() {
  try {
    const raw = await fs.readFile(KNOWLEDGE_JSON_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!json.items) json.items = [];
    if (!json.digests) json.digests = [];
    if (!json.runs) json.runs = [];
    return json;
  } catch {
    return { items: [], digests: [], runs: [] };
  }
}

async function checkpointKnowledge(kb) {
  // use your utils atomic writer with rolling backups
  await ensureDir(path.dirname(KNOWLEDGE_JSON_PATH));
  await saveJsonCheckpoint(KNOWLEDGE_JSON_PATH, kb);
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Canonical ID & merge logic
 *  ────────────────────────────────────────────────────────────────────────────*/
function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function canonicalIdFrom(fields) {
  // Prefer stable unique keys; fall back to url
  const basis =
    fields.canonicalId ||
    fields.videoId ||
    fields.itemId ||
    fields.url ||
    JSON.stringify({ t: fields.title || "", s: fields.sourceType || "", u: fields.url || "" });
  return sha256(`${fields.sourceType || "unknown"}|${basis}`);
}

function mergeItem(existing, incoming) {
  // Do not drop existing fields; augment/overwrite safely
  const out = { ...existing };

  // Always keep earliest ingestedAt; update updatedAt
  out.ingestedAt = existing.ingestedAt || incoming.ingestedAt || new Date().toISOString();
  out.updatedAt = new Date().toISOString();

  // Basic fields
  for (const key of ["title", "url", "author", "publishedAt", "collection", "sourceType", "sourceKey"]) {
    if (incoming[key]) out[key] = incoming[key];
  }

  // Tags: merge & dedupe
  const tags = new Set([...(existing.tags || []), ...(incoming.tags || [])]);
  out.tags = Array.from(tags);

  // Enrichment/classification scaffolding (preserve if present)
  out.enriched = existing.enriched || null;
  out.classifications = existing.classifications || [];

  // Raw payload (keep last seen; useful for debugging)
  out.raw = incoming.raw || existing.raw || null;

  return out;
}

async function upsertKnowledgeItem(kb, incoming) {
  const cid = incoming.canonicalId || canonicalIdFrom(incoming);
  incoming.canonicalId = cid;

  // Try match by canonicalId first
  let idx = kb.items.findIndex((i) => i.canonicalId === cid);

  // Fallback: match by URL if canonicalId changed
  if (idx === -1 && incoming.url) {
    idx = kb.items.findIndex((i) => i.url && i.url === incoming.url);
  }

  if (idx === -1) {
    const record = {
      canonicalId: cid,
      ingestedAt: incoming.ingestedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: incoming.title || "(untitled)",
      url: incoming.url || "",
      tags: incoming.tags || [],
      author: incoming.author || "",
      publishedAt: incoming.publishedAt || "",
      collection: incoming.collection || "",
      sourceType: incoming.sourceType || "unknown",
      sourceKey: incoming.sourceKey || "",
      raw: incoming.raw || null,
      enriched: null,
      classifications: []
    };
    kb.items.push(record);
    await checkpointKnowledge(kb);
    return { created: true, id: cid };
  } else {
    const merged = mergeItem(kb.items[idx], incoming);
    kb.items[idx] = merged;
    await checkpointKnowledge(kb);
    return { created: false, id: cid };
  }
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Modes & scheduling
 *  ────────────────────────────────────────────────────────────────────────────*/
function shouldRunForMode(mode, lastRunISO) {
  const lastRun = lastRunISO ? new Date(lastRunISO) : null;
  const now = new Date();

  switch ((mode || "daily").toLowerCase()) {
    case "paused":
      return false;
    case "once":
      // If there's any lastRun, we treat as already completed
      return !lastRun;
    case "weekly":
      if (!lastRun) return true;
      return now.getTime() - lastRun.getTime() >= 7 * 24 * 3600 * 1000;
    case "daily":
    default:
      if (!lastRun) return true;
      return now.getTime() - lastRun.getTime() >= 24 * 3600 * 1000;
  }
}

function sinceFromFreshness(freshnessDays) {
  if (!freshnessDays || freshnessDays <= 0) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - freshnessDays);
  return d;
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Normalizers (Raindrop / YT / RSS / File)
 *  ────────────────────────────────────────────────────────────────────────────*/
function normRaindropItem(ri, collectionId, collectionTitle) {
  const url = ri.link || ri.url || "";
  const created = ri.created || ri.lastUpdate || null;
  return {
    sourceType: "raindrop",
    sourceKey: `raindrop:${collectionId}`,
    itemId: ri._id || null,
    title: ri.title || ri.excerpt || "(untitled)",
    url,
    tags: Array.isArray(ri.tags) ? ri.tags : [],
    author: ri.domain || "",
    publishedAt: created || "",
    collection: collectionTitle || (collectionId === "0" ? "misc" : String(collectionId)),
    raw: ri
  };
}

function normYouTubePlaylistItem(pi, playlistId) {
  const snippet = pi.snippet || {};
  const details = pi.contentDetails || {};
  const videoId = details.videoId || (snippet.resourceId ? snippet.resourceId.videoId : null);
  const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
  return {
    sourceType: "youtube-playlist",
    sourceKey: `youtube:playlist:${playlistId}`,
    videoId,
    title: snippet.title || "(untitled)",
    url,
    tags: ["youtube"],
    author: snippet.channelTitle || "",
    publishedAt: snippet.publishedAt || details.videoPublishedAt || "",
    raw: pi
  };
}

function normYouTubeRssItem(it, channelId, handle) {
  const url = it.link || "";
  const published = it.isoDate || it.pubDate || "";
  return {
    sourceType: "youtube-channel",
    sourceKey: `youtube:channel:${channelId}`,
    title: it.title || "(untitled)",
    url,
    tags: ["youtube"],
    author: handle ? `@${handle}` : "",
    publishedAt: published,
    raw: it
  };
}

function normFileItem(obj, sourceId) {
  // obj = { title, url, tags?, publishedAt? }
  return {
    sourceType: "file-import",
    sourceKey: `file:${sourceId}`,
    title: obj.title || obj.url || "(untitled)",
    url: obj.url || "",
    tags: obj.tags || ["import"],
    author: obj.author || "",
    publishedAt: obj.publishedAt || "",
    raw: obj
  };
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Raindrop
 *  ────────────────────────────────────────────────────────────────────────────*/
async function fetchRaindropCollection(collectionId, perPage, sinceDate) {
  if (!RAINDROP_TOKEN) {
    log("RAINDROP_TOKEN missing; skipping Raindrop.");
    return [];
  }

  let page = 0;
  const items = [];
  const baseUrl = `https://api.raindrop.io/rest/v1/raindrops/${collectionId}`;
  const sinceISO = sinceDate ? sinceDate.toISOString() : null;

  while (true) {
    page += 1;
    const url = new URL(baseUrl);
    url.searchParams.set("perpage", String(perPage || 100));
    url.searchParams.set("page", String(page));

    // NOTE: Raindrop search supports rich queries, but to keep safe, we pull pages and filter client-side by created date.
    const json = await fetchJson(url, {
      headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` }
    });

    const batch = (json.items || []);
    if (!batch.length) break;

    const filtered = sinceISO
      ? batch.filter((it) => !it.created || new Date(it.created) >= new Date(sinceISO))
      : batch;

    items.push(...filtered);

    // If we requested a freshness window and the tail of this page is older than since, we can stop early.
    if (sinceISO) {
      const hasOlder = batch.some((it) => it.created && new Date(it.created) < new Date(sinceISO));
      if (hasOlder) break;
    }

    if (!json.pages || page >= json.pages) break;
  }

  return items;
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  YouTube playlist (incremental via publishedAfter)
 *  ────────────────────────────────────────────────────────────────────────────*/
async function fetchYouTubePlaylist(playlistId, sinceDate) {
  if (!YT_API_KEY) {
    log("YOUTUBE_API_KEY missing; skipping playlist", { playlistId });
    return [];
  }

  const items = [];
  let pageToken;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("key", YT_API_KEY);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (sinceDate) url.searchParams.set("publishedAfter", sinceDate.toISOString());

    const json = await fetchJson(url);
    items.push(...(json.items || []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return items;
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  YouTube channels via RSS
 *  ────────────────────────────────────────────────────────────────────────────*/
async function loadHandleCache() {
  try {
    const raw = await fs.readFile(HANDLE_CACHE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
async function saveHandleCache(c) {
  await ensureDir(CACHE_ROOT);
  await fs.writeFile(HANDLE_CACHE_PATH, JSON.stringify(c, null, 2), "utf8");
}

async function resolveChannelId(handle) {
  // Prefer cache
  const cache = await loadHandleCache();
  if (cache[handle]) return cache[handle];

  if (!YT_API_KEY) return null;

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "channel");
    url.searchParams.set("q", `@${handle}`);
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("key", YT_API_KEY);

    const json = await fetchJson(url);
    const hit = (json.items || [])[0];
    const channelId = hit?.snippet?.channelId || hit?.id?.channelId || null;
    if (channelId) {
      cache[handle] = channelId;
      await saveHandleCache(cache);
    }
    return channelId;
  } catch (e) {
    log("Failed to resolve handle", { handle, error: e.message });
    return null;
  }
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  File imports: .html (Netscape bookmarks), .csv (url,title[,tags]),
 *                .txt (one URL per line)
 *  ────────────────────────────────────────────────────────────────────────────*/
async function importFile(pathOnDisk) {
  const ext = pathOnDisk.toLowerCase().split(".").pop();
  const raw = await fs.readFile(pathOnDisk, "utf8");

  if (ext === "html" || ext === "htm") {
    const out = [];
    const re = /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
    let m;
    while ((m = re.exec(raw))) {
      const url = m[1];
      const title = m[2]?.replace(/<[^>]+>/g, "") || url;
      out.push({ url, title, tags: ["import:html"] });
    }
    return out;
  }

  if (ext === "csv") {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    // naive CSV: url,title[,tags]
    for (const line of lines) {
      const parts = line.split(",");
      const url = parts[0]?.trim();
      const title = parts[1]?.trim();
      const tags = (parts[2]?.trim() || "").split("|").filter(Boolean);
      if (url) out.push({ url, title: title || url, tags: tags.length ? tags : ["import:csv"] });
    }
    return out;
  }

  if (ext === "txt") {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.map((url) => ({ url, title: url, tags: ["import:txt"] }));
  }

  // Fallback: treat as newline-delimited URLs
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((url) => ({ url, title: url, tags: ["import:unknown"] }));
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Config normalization
 *  ────────────────────────────────────────────────────────────────────────────*/
async function loadSourceConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    log("Could not read config/sources.json; nothing to ingest.", { error: e.message });
    return {};
  }
}

function normalizeCollectionIds(collectionIds) {
  // Accept ["0", "123"] or [{id:"0", mode:"daily", freshnessDays:1}]
  return (collectionIds || []).map((c) => (typeof c === "string" ? { id: c, mode: "daily", freshnessDays: 1 } : c));
}
function normalizePlaylistIds(playlistIds) {
  return (playlistIds || []).map((p) => (typeof p === "string" ? { id: p, mode: "daily", freshnessDays: 1 } : p));
}
function normalizeChannelHandles(handles) {
  return (handles || []).map((h) => (typeof h === "string" ? { handle: h, mode: "daily", freshnessDays: 1 } : h));
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  Main ingest
 *  ────────────────────────────────────────────────────────────────────────────*/
export async function ingest() {
  await ensureDir(RUN_DIR);
  await ensureDir(CACHE_ROOT);
  await ensureDir(path.dirname(KNOWLEDGE_JSON_PATH));

  const config = await loadSourceConfig();
  const meta = await loadMeta();
  const kb = await loadKnowledge();

  const runInfo = {
    startedAt: new Date().toISOString(),
    runDirectory: path.relative(ROOT_DIR, RUN_DIR),
    sources: []
  };

  /** RAINDROP **/
  if (config.raindrop && RAINDROP_TOKEN) {
    const collections = normalizeCollectionIds(config.raindrop.collectionIds);
    const perPage = Number(config.raindrop.perPage ?? 100);

    for (const c of collections) {
      const srcKey = `raindrop:${c.id}`;
      const last = meta.sources[srcKey]?.lastRun || null;
      const done = meta.sources[srcKey]?.done || false;

      if (c.mode?.toLowerCase() === "once" && done) continue;
      if (!shouldRunForMode(c.mode, last)) continue;

      const since = sinceFromFreshness(c.freshnessDays);
      log("Fetching Raindrop", { collectionId: c.id, mode: c.mode || "daily", since: since?.toISOString() || null });

      try {
        const items = await fetchRaindropCollection(c.id, perPage, since);
        // Optional: record raw dump for debugging
        const dumpPath = path.join(RUN_DIR, `raindrop-${String(c.id).replace(/[^a-z0-9\-_.]/gi, "_")}.json`);
        await fs.writeFile(dumpPath, JSON.stringify(items, null, 2), "utf8");

        // Enrich collection title (uncategorized -> misc)
        let collectionTitle = String(c.id);
        if (c.id === "0") collectionTitle = "misc";

        let createdCount = 0;
        for (const ri of items) {
          const normalized = normRaindropItem(ri, String(c.id), collectionTitle);
          normalized.canonicalId = canonicalIdFrom({ sourceType: "raindrop", itemId: ri._id || normalized.url });
          const res = await upsertKnowledgeItem(kb, normalized);
          if (res.created) createdCount++;
        }

        runInfo.sources.push({ type: "raindrop", collectionId: c.id, count: items.length, created: createdCount, dumpPath: path.relative(ROOT_DIR, dumpPath) });
        meta.sources[srcKey] = { lastRun: new Date().toISOString(), done: (c.mode || "").toLowerCase() === "once" };
        await saveMeta(meta);
      } catch (e) {
        log("Raindrop fetch failed", { collectionId: c.id, error: e.message });
      }
    }
  } else if (config.raindrop) {
    log("Skipping Raindrop (no token).");
  }

  /** YOUTUBE PLAYLISTS **/
  if (config.youtube) {
    const playlists = normalizePlaylistIds(config.youtube.playlistIds);
    for (const p of playlists) {
      const srcKey = `youtube:playlist:${p.id}`;
      const last = meta.sources[srcKey]?.lastRun || null;
      const done = meta.sources[srcKey]?.done || false;

      if (p.mode?.toLowerCase() === "once" && done) continue;
      if (!shouldRunForMode(p.mode, last)) continue;

      const since = sinceFromFreshness(p.freshnessDays);
      log("Fetching YouTube playlist", { playlistId: p.id, mode: p.mode || "daily", since: since?.toISOString() || null });
      try {
        const items = await fetchYouTubePlaylist(p.id, since);
        const dumpPath = path.join(RUN_DIR, `youtube-playlist-${String(p.id).replace(/[^a-z0-9\-_.]/gi, "_")}.json`);
        await fs.writeFile(dumpPath, JSON.stringify(items, null, 2), "utf8");

        let createdCount = 0;
        for (const pi of items) {
          const normalized = normYouTubePlaylistItem(pi, p.id);
          normalized.canonicalId = canonicalIdFrom({ sourceType: "youtube-playlist", videoId: normalized.videoId || normalized.url });
          const res = await upsertKnowledgeItem(kb, normalized);
          if (res.created) createdCount++;
        }

        runInfo.sources.push({ type: "youtube-playlist", playlistId: p.id, count: items.length, created: createdCount, dumpPath: path.relative(ROOT_DIR, dumpPath) });
        meta.sources[srcKey] = { lastRun: new Date().toISOString(), done: (p.mode || "").toLowerCase() === "once" };
        await saveMeta(meta);
      } catch (e) {
        log("YouTube playlist fetch failed", { playlistId: p.id, error: e.message });
      }
    }
  }

  /** YOUTUBE CHANNELS (via handles → RSS) **/
  if (config.youtube) {
    const handles = normalizeChannelHandles(config.youtube.channelHandles);
    for (const h of handles) {
      const handle = (h.handle || "").trim();
      if (!handle) continue;

      const srcKey = `youtube:handle:${handle}`;
      const last = meta.sources[srcKey]?.lastRun || null;
      if (!shouldRunForMode(h.mode, last)) continue;

      try {
        const channelId = await resolveChannelId(handle);
        if (!channelId) {
          log("No channelId for handle; skipping", { handle });
          continue;
        }

        const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        log("Fetching YouTube RSS", { handle, channelId, mode: h.mode || "daily" });

        const feed = await parser.parseURL(feedUrl);
        const since = sinceFromFreshness(h.freshnessDays);
        const items = (feed.items || []).filter((it) => {
          if (!since) return true;
          const ts = it.isoDate || it.pubDate;
          return ts ? new Date(ts) >= since : true;
        });

        const dumpPath = path.join(RUN_DIR, `youtube-channel-${String(channelId).replace(/[^a-z0-9\-_.]/gi, "_")}.json`);
        await fs.writeFile(dumpPath, JSON.stringify(feed, null, 2), "utf8");

        let createdCount = 0;
        for (const it of items) {
          const normalized = normYouTubeRssItem(it, channelId, handle);
          normalized.canonicalId = canonicalIdFrom({ sourceType: "youtube-channel", url: normalized.url });
          const res = await upsertKnowledgeItem(kb, normalized);
          if (res.created) createdCount++;
        }

        runInfo.sources.push({ type: "youtube-channel", handle, channelId, count: items.length, created: createdCount, dumpPath: path.relative(ROOT_DIR, dumpPath) });
        meta.sources[srcKey] = { lastRun: new Date().toISOString(), done: (h.mode || "").toLowerCase() === "once" };
        await saveMeta(meta);
      } catch (e) {
        log("YouTube RSS fetch failed", { handle, error: e.message });
      }
    }
  }

  /** FILE IMPORTS (optional) **/
  if (Array.isArray(config.files)) {
    for (const f of config.files) {
      const id = f.id || f.path || "file";
      const srcKey = `file:${id}`;
      const last = meta.sources[srcKey]?.lastRun || null;
      const done = meta.sources[srcKey]?.done || false;

      const mode = (f.mode || "once").toLowerCase();
      if (mode === "paused") continue;
      if (mode === "once" && done) continue;
      if (!shouldRunForMode(mode, last)) continue;

      try {
        const diskPath = path.isAbsolute(f.path) ? f.path : path.join(ROOT_DIR, f.path);
        log("Importing file", { id, path: diskPath, mode });
        const rows = await importFile(diskPath);

        let createdCount = 0;
        for (const r of rows) {
          const normalized = normFileItem(r, id);
          normalized.canonicalId = canonicalIdFrom({ sourceType: "file-import", url: normalized.url });
          const res = await upsertKnowledgeItem(kb, normalized);
          if (res.created) createdCount++;
        }

        runInfo.sources.push({ type: "file-import", id, count: rows.length, created: createdCount });
        meta.sources[srcKey] = { lastRun: new Date().toISOString(), done: mode === "once" };
        await saveMeta(meta);
      } catch (e) {
        log("File import failed", { id, error: e.message });
      }
    }
  }

  // Record run, checkpoint knowledge
  runInfo.completedAt = new Date().toISOString();
  kb.runs.push(runInfo);
  await checkpointKnowledge(kb);

  log("Ingestion complete", {
    knowledgeJson: KNOWLEDGE_JSON_PATH,
    items: kb.items.length
  });
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  CLI
 *  ────────────────────────────────────────────────────────────────────────────*/
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((error) => {
    console.error("Ingest step failed", error);
    process.exitCode = 1;
  });
}
