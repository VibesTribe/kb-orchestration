import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config", "sources.json");
const DATA_ROOT = path.join(ROOT_DIR, "data", "raw");

const DEFAULT_DATE = new Date();
const RUN_STAMP = DEFAULT_DATE.toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(
  DATA_ROOT,
  DEFAULT_DATE.toISOString().slice(0, 10),
  RUN_STAMP
);

const parser = new Parser();

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadSourceConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    log("Could not read config/sources.json; skipping optional sources", { error: error.message });
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText} - ${body}`);
  }
  return response.json();
}

async function ingestRaindropSource(config) {
  const token = process.env.RAINDROP_TOKEN;
  if (!token) {
    log("RAINDROP_TOKEN missing; skipping Raindrop ingestion");
    return [];
  }

  const collectionIds = config?.collectionIds?.length ? config.collectionIds : ["0"];
  const perPage = Number(config?.perPage ?? 100);

  const results = [];
  for (const collectionId of collectionIds) {
    log("Fetching Raindrop collection", { collectionId });
    const items = await fetchRaindropCollection(collectionId, perPage, token);
    const filePath = path.join(RUN_DIR, `raindrop-${sanitize(collectionId)}.json`);
    await fs.writeFile(filePath, JSON.stringify(items, null, 2), "utf8");
    results.push({ type: "raindrop", collectionId, count: items.length, filePath });
  }
  return results;
}

async function fetchRaindropCollection(collectionId, perPage, token) {
  let page = 0;
  const items = [];
  const baseUrl = `https://api.raindrop.io/rest/v1/raindrops/${collectionId}`;

  while (true) {
    page += 1;
    const url = new URL(baseUrl);
    url.searchParams.set("perpage", perPage.toString());
    url.searchParams.set("page", page.toString());

    const json = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    items.push(...(json.items ?? []));
    if (!json.pages || page >= json.pages) {
      break;
    }
  }

  return items;
}

async function ingestYoutubeSource(config) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    log("YOUTUBE_API_KEY missing; skipping YouTube ingestion");
    return [];
  }

  const playlistIds = config?.playlistIds ?? [];
  const channelIds = config?.channelIds ?? [];
  const results = [];

  for (const playlistId of playlistIds) {
    if (!playlistId || playlistId.includes("GOES_HERE")) continue;
    log("Fetching YouTube playlist", { playlistId });
    const playlistItems = await fetchYoutubePlaylist(playlistId, apiKey);
    const filePath = path.join(RUN_DIR, `youtube-playlist-${sanitize(playlistId)}.json`);
    await fs.writeFile(filePath, JSON.stringify(playlistItems, null, 2), "utf8");
    results.push({ type: "youtube-playlist", playlistId, count: playlistItems.length, filePath });
  }

  for (const channelId of channelIds) {
    if (!channelId || channelId.includes("GOES_HERE")) continue;
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    log("Fetching YouTube channel RSS", { channelId });
    const feed = await parser.parseURL(feedUrl);
    const filePath = path.join(RUN_DIR, `youtube-channel-${sanitize(channelId)}.json`);
    await fs.writeFile(filePath, JSON.stringify(feed, null, 2), "utf8");
    results.push({ type: "youtube-channel", channelId, count: feed.items?.length ?? 0, filePath });
  }

  return results;
}

async function fetchYoutubePlaylist(playlistId, apiKey) {
  const items = [];
  let pageToken;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const json = await fetchJson(url);
    items.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return items;
}

async function ingestRssFeeds(feeds = []) {
  const results = [];
  for (const feed of feeds) {
    if (!feed?.url || feed.url.includes("example.com")) continue;
    log("Fetching RSS feed", { feed: feed.id ?? feed.url });
    const parsed = await parser.parseURL(feed.url);
    const filePath = path.join(RUN_DIR, `rss-${sanitize(feed.id ?? "feed")}.json`);
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");
    results.push({ type: "rss", id: feed.id ?? feed.url, count: parsed.items?.length ?? 0, filePath });
  }
  return results;
}

function sanitize(value) {
  return String(value).replace(/[^a-z0-9\-_.]/gi, "_").toLowerCase();
}

export async function ingest() {
  await ensureDirectory(RUN_DIR);
  const config = await loadSourceConfig();
  const manifest = {
    startedAt: new Date().toISOString(),
    runDirectory: path.relative(ROOT_DIR, RUN_DIR),
    sources: []
  };

  const raindropResults = await ingestRaindropSource(config?.raindrop);
  manifest.sources.push(...raindropResults);

  const youtubeResults = await ingestYoutubeSource(config?.youtube);
  manifest.sources.push(...youtubeResults);

  const rssResults = await ingestRssFeeds(config?.rss);
  manifest.sources.push(...rssResults);

  manifest.completedAt = new Date().toISOString();
  const manifestPath = path.join(RUN_DIR, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  log("Ingestion complete", { manifest: path.relative(ROOT_DIR, manifestPath) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((error) => {
    console.error("Ingest step failed", error);
    process.exitCode = 1;
  });
}



