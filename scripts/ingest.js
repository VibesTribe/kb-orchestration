// scripts/ingest.js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProgress, markSeen } from "./lib/state.js";
import { upsertFile } from "./lib/github-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_FILE = path.join(ROOT_DIR, "config", "sources.json");

// Knowledgebase file path in VibesTribe/knowledgebase
const KB_FILE = "knowledge.json";

async function loadSources() {
  const raw = await fs.readFile(CONFIG_FILE, "utf8");
  return JSON.parse(raw);
}

async function loadKnowledge() {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/VibesTribe/knowledgebase/main/${KB_FILE}`);
    if (!res.ok) return { bookmarks: [] };
    return await res.json();
  } catch {
    return { bookmarks: [] };
  }
}

async function saveKnowledge(knowledge) {
  await upsertFile(KB_FILE, JSON.stringify(knowledge, null, 2), "Update knowledge.json from ingest");
}

function withinWindow(dateStr, window = "1d") {
  const created = new Date(dateStr);
  const now = new Date();
  const days = window.endsWith("d") ? parseInt(window) : 1;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return created >= cutoff;
}

export async function ingest() {
  const sources = await loadSources();
  const progress = await loadProgress();
  const knowledge = await loadKnowledge();

  const newItems = [];

  // Example: handle raindrop
  if (sources.raindrop?.collections) {
    for (const c of sources.raindrop.collections) {
      const id = `raindrop-${c.id}`;
      if (c.mode === "once" && progress.seen[id]) continue;

      const item = {
        id,
        title: `Raindrop collection ${c.name}`,
        link: `https://raindrop.io/collection/${c.id}`,
        created: new Date().toISOString(),
        collection: c.name,
        tags: [],
        summary: null,
        enriched: false,
      };
      knowledge.bookmarks.push(item);
      newItems.push(item);

      await markSeen(id);
    }
  }

  // Example: handle YouTube playlists
  if (sources.youtube?.playlists) {
    for (const p of sources.youtube.playlists) {
      const id = `yt-playlist-${p.id}`;
      if (p.mode === "once" && progress.seen[id]) continue;

      const item = {
        id,
        title: `YouTube playlist ${p.id}`,
        link: `https://www.youtube.com/playlist?list=${p.id}`,
        created: new Date().toISOString(),
        collection: "YouTube",
        tags: [],
        summary: null,
        enriched: false,
      };
      knowledge.bookmarks.push(item);
      newItems.push(item);

      await markSeen(id);
    }
  }

  // Example: handle YouTube channels with window
  if (sources.youtube?.channels) {
    for (const ch of sources.youtube.channels) {
      const id = `yt-channel-${ch.handle}-${new Date().toISOString().split("T")[0]}`;
      if (progress.seen[id]) continue;

      const item = {
        id,
        title: `YouTube channel ${ch.handle}`,
        link: `https://youtube.com/@${ch.handle}`,
        created: new Date().toISOString(),
        collection: "YouTube",
        tags: [],
        summary: null,
        enriched: false,
      };

      // Only include if within default window
      if (withinWindow(item.created, sources.youtube.defaultWindow ?? "1d")) {
        knowledge.bookmarks.push(item);
        newItems.push(item);
        await markSeen(id);
      }
    }
  }

  if (newItems.length) {
    await saveKnowledge(knowledge);
    console.log(`Ingest saved ${newItems.length} new items`);
  } else {
    console.log("No new items ingested");
  }

  return newItems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch((err) => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}
