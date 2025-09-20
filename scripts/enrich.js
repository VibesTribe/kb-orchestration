import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { callOpenRouter } from "./lib/openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RAW_ROOT = path.join(ROOT_DIR, "data", "raw");
const ENRICHED_ROOT = path.join(ROOT_DIR, "data", "enriched");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const SUMMARY_CACHE_PATH = path.join(CACHE_ROOT, "summaries.json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

export async function enrich() {
  const latestRun = await getLatestIngestRun();
  if (!latestRun) {
    log("No raw ingest runs found; skip enrichment");
    return;
  }

  const { dayDir, stampDir, manifestPath, manifest } = latestRun;
  const enrichedRunDir = path.join(ENRICHED_ROOT, dayDir, stampDir);
  await ensureDir(enrichedRunDir);
  await ensureDir(CACHE_ROOT);

  const summaryCache = await loadJson(SUMMARY_CACHE_PATH, {});
  const dedupe = new Map();
  const enrichedItems = [];

  for (const source of manifest.sources ?? []) {
    const absolutePath = path.join(ROOT_DIR, source.filePath ?? "");
    const exists = await fileExists(absolutePath);
    if (!exists) {
      log("Source file missing during enrichment", { file: absolutePath });
      continue;
    }

    const rawContent = await loadJson(absolutePath, null);
    if (!rawContent) continue;

    const normalizedItems = normalizeSourceItems(source, rawContent);
    for (const item of normalizedItems) {
      const canonicalId = canonicalize(item.url ?? item.id);
      if (!canonicalId) continue;
      if (dedupe.has(canonicalId)) continue;

      const cached = summaryCache[canonicalId];
      let summary = cached?.summary ?? null;
      if (!summary) {
        summary = await generateSummary(item);
        summaryCache[canonicalId] = {
          summary,
          updatedAt: new Date().toISOString(),
          title: item.title,
          url: item.url,
          sourceType: item.sourceType
        };
      }

      dedupe.set(canonicalId, true);
      enrichedItems.push({
        ...item,
        canonicalId,
        summary
      });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    inputManifest: path.relative(ROOT_DIR, manifestPath),
    itemCount: enrichedItems.length,
    items: enrichedItems
  };

  const itemsPath = path.join(enrichedRunDir, "items.json");
  await fs.writeFile(itemsPath, JSON.stringify(output, null, 2), "utf8");
  await fs.writeFile(SUMMARY_CACHE_PATH, JSON.stringify(summaryCache, null, 2), "utf8");
  log("Enrichment complete", { itemsPath: path.relative(ROOT_DIR, itemsPath), count: enrichedItems.length });
}

async function getLatestIngestRun() {
  const dayDirs = await listDirectories(RAW_ROOT);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();

  for (const dayDir of dayDirs) {
    const dayPath = path.join(RAW_ROOT, dayDir);
    const stampDirs = await listDirectories(dayPath);
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const manifestPath = path.join(dayPath, stampDir, "manifest.json");
      const manifest = await loadJson(manifestPath, null);
      if (manifest) {
        return { dayDir, stampDir, manifestPath, manifest };
      }
    }
  }
  return null;
}

function normalizeSourceItems(source, rawContent) {
  switch (source.type) {
    case "raindrop":
      return normalizeRaindropItems(rawContent, source);
    case "youtube-playlist":
      return normalizeYoutubePlaylistItems(rawContent, source);
    case "youtube-channel":
      return normalizeYoutubeChannelItems(rawContent, source);
    case "rss":
      return normalizeRssItems(rawContent, source);
    default:
      return [];
  }
}

function normalizeRaindropItems(items, source) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: `raindrop-${item._id ?? item.link}`,
    sourceType: "raindrop",
    sourceId: String(source.collectionId ?? item.collection?.$id ?? "unknown"),
    title: item.title ?? item.link ?? "Untitled bookmark",
    url: item.link ?? null,
    description: item.excerpt ?? "",
    publishedAt: item.created ?? item.lastUpdate ?? null,
    authors: item.author ? [item.author] : [],
    tags: Array.isArray(item.tags) ? item.tags : [],
    thumbnail: item.cover ?? null,
    raw: item
  }));
}

function normalizeYoutubePlaylistItems(items, source) {
  if (!Array.isArray(items)) return [];
  return items.map((entry) => {
    const snippet = entry.snippet ?? {};
    const content = entry.contentDetails ?? {};
    const videoId = content.videoId ?? snippet.resourceId?.videoId ?? entry.id;
    const channelTitle = snippet.videoOwnerChannelTitle || snippet.channelTitle;
    const publishedAt = content.videoPublishedAt ?? snippet.publishedAt ?? null;
    return {
      id: `youtube-playlist-${videoId}`,
      sourceType: "youtube-playlist",
      sourceId: source.playlistId ?? source.playlistID ?? "unknown-playlist",
      title: snippet.title ?? "Untitled video",
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : snippet.resourceId?.videoId ?? null,
      description: snippet.description ?? "",
      publishedAt,
      authors: channelTitle ? [channelTitle] : [],
      tags: Array.isArray(snippet.tags) ? snippet.tags : [],
      thumbnail: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url ?? null,
      raw: entry
    };
  });
}

function normalizeYoutubeChannelItems(feed, source) {
  if (!feed || !Array.isArray(feed.items)) return [];
  return feed.items.map((item) => {
    const url = item.link ?? item.guid ?? null;
    return {
      id: `youtube-channel-${item.id ?? item.guid ?? item.link}`,
      sourceType: "youtube-channel",
      sourceId: source.channelId ?? source.handle ?? "unknown-channel",
      title: item.title ?? "Untitled video",
      url,
      description: item.contentSnippet ?? item.content ?? "",
      publishedAt: item.pubDate ?? null,
      authors: item.author ? [item.author] : [],
      tags: [],
      thumbnail: item.enclosure?.url ?? null,
      raw: item
    };
  });
}

function normalizeRssItems(feed, source) {
  if (!feed || !Array.isArray(feed.items)) return [];
  return feed.items.map((item) => ({
    id: `rss-${sanitize(item.guid ?? item.id ?? item.link ?? item.title)}`,
    sourceType: "rss",
    sourceId: source.id ?? source.url ?? "rss",
    title: item.title ?? "Untitled article",
    url: item.link ?? null,
    description: item.contentSnippet ?? item.content ?? "",
    publishedAt: item.isoDate ?? item.pubDate ?? null,
    authors: item.creator ? [item.creator] : item.author ? [item.author] : [],
    tags: Array.isArray(item.categories) ? item.categories : [],
    thumbnail: item.enclosure?.url ?? null,
    raw: item
  }));
}

async function generateSummary(item) {
  const baseText = buildSummaryPrompt(item);
  if (!baseText.trim()) return "";

  if (!OPENROUTER_API_KEY) {
    return truncate(baseText, 280);
  }

  try {
    const { content, model } = await callOpenRouter([
      {
        role: "system",
        content:
          "You summarise research signals for an internal knowledgebase. Provide a concise, actionable summary (max 3 sentences) highlighting why the item matters."
      },
      {
        role: "user",
        content: baseText
      }
    ], {
      maxTokens: 180,
      temperature: 0.2
    });
    log("Generated summary", { model });
    return content.trim();
  } catch (error) {
    log("OpenRouter summarisation failed", { error: error.message, title: item.title });
    return truncate(baseText, 280);
  }
}

function buildSummaryPrompt(item) {
  const parts = [];
  parts.push(`Title: ${item.title ?? "(untitled)"}`);
  if (item.description) {
    parts.push(`Content: ${truncate(item.description, 2000)}`);
  }
  if (item.tags?.length) {
    parts.push(`Tags: ${item.tags.join(", ")}`);
  }
  if (item.url) {
    parts.push(`URL: ${item.url}`);
  }
  return parts.join("\n");
}

function canonicalize(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function truncate(text, limit) {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (fallback === null) {
      log("Failed to parse JSON", { filePath, error: error.message });
    }
    return fallback;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((error) => {
    console.error("Enrichment step failed", error);
    process.exitCode = 1;
  });
}
