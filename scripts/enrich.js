import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./lib/openrouter.js";
import {
  log,
  ensureDir,
  loadJson,
  saveJson,
  listDirectories,
  hash,
  truncate,
} from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RAW_ROOT = path.join(ROOT_DIR, "data", "raw");
const ENRICHED_ROOT = path.join(ROOT_DIR, "data", "enriched");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const SUMMARY_CACHE_PATH = path.join(CACHE_ROOT, "summaries.json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

  const itemsPath = path.join(enrichedRunDir, "items.json");
  const itemsSoFar = await loadJson(itemsPath, { items: [] });

  for (const source of manifest.sources ?? []) {
    let absolutePath = source.filePath ?? "";
    if (!absolutePath) continue;
    if (!path.isAbsolute(absolutePath)) {
      absolutePath = path.join(ROOT_DIR, absolutePath);
    }

    let rawContent;
    try {
      rawContent = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    } catch {
      continue;
    }

    const normalizedItems = normalizeSourceItems(source, rawContent);
    for (const item of normalizedItems) {
      try {
        const canonicalId = hash(item.url ?? item.id);
        if (!canonicalId || dedupe.has(canonicalId)) continue;

        const cached = summaryCache[canonicalId];
        let summary = cached?.summary ?? null;
        if (!summary) {
          summary = await generateSummary(item);
          summaryCache[canonicalId] = {
            summary,
            updatedAt: new Date().toISOString(),
            title: item.title,
            url: item.url,
            sourceType: item.sourceType,
          };
          await saveJson(SUMMARY_CACHE_PATH, summaryCache);
        }

        const enrichedItem = { ...item, canonicalId, summary };
        dedupe.set(canonicalId, true);
        enrichedItems.push(enrichedItem);
        itemsSoFar.items.push(enrichedItem);

        // ✅ Save progress after each item
        await saveJson(itemsPath, itemsSoFar);
      } catch (err) {
        log("Enrichment error", { err: err.message, title: item.title });
        continue;
      }
    }
  }

  log("Enrichment complete", { count: enrichedItems.length });
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
      if (manifest) return { dayDir, stampDir, manifestPath, manifest };
    }
  }
  return null;
}

function normalizeSourceItems(source, rawContent) {
  // 🔹 Keep your normalize functions (raindrop, youtube, rss) as before.
  return [];
}

async function generateSummary(item) {
  const baseText = `${item.title}\n${truncate(item.description ?? "", 1000)}`;
  if (!OPENROUTER_API_KEY) return truncate(baseText, 280);

  try {
    const { content } = await callOpenRouter(
      [
        { role: "system", content: "Summarize for internal knowledgebase." },
        { role: "user", content: baseText },
      ],
      { maxTokens: 180, temperature: 0.2 }
    );
    return content.trim();
  } catch (err) {
    log("Summary gen failed", { err: err.message });
    return truncate(baseText, 280);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((err) => {
    console.error("Enrichment failed", err);
    process.exitCode = 1;
  });
}
