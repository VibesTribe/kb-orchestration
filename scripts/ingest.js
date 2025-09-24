// scripts/ingest.js
// Incremental ingest from sources.json → knowledge.json in VibesTribe/knowledgebase
// Preserves state so each item is only pulled once (except for daily/weekly modes)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProgress, markSeen } from "./lib/state.js";
import { pushUpdate } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_FILE = path.join(ROOT_DIR, "config", "sources.json");

async function loadSources() {
  const raw = await fs.readFile(CONFIG_FILE, "utf8");
  return JSON.parse(raw);
}

async function loadKnowledge() {
  try {
    const res = await fetch("https://raw.githubusercontent.com/VibesTribe/knowledgebase/main/knowledge.json");
    if (!res.ok) return { generatedAt: new Date().toISOString(), items: [] };
    return await res.json();
  } catch {
    return { generatedAt: new Date().toISOString(), items: [] };
  }
}

function withinWindow(dateStr, window = "1d") {
  const created = new Date(dateStr);
  const now = new Date();
  const days = window.endsWith("d") ? parseInt(window) : 1;
  const cutoff = new Date(now.getTime() - days * 86400000);
  return created >= cutoff;
}

export async function ingest() {
  const sources = await loadSources();
  const progress = await loadProgress();
  const knowledge = await loadKnowledge();

  let newItems = [];

  // Raindrop collections
  if (sources.raindrop?.collections) {
    for (const c of sources.raindrop.collections) {
      const id = `raindrop-${c.id}`;
      if (c.mode === "once" && progress.seen[id]) continue;

      const item = {
        id,
        title: `Raindrop collection ${c.name}`,
        url: `https://raindrop.io/collection/${c.id}`,
        sourceType: "raindrop",
        collectedAt: new Date().toISOString()
      };

      knowledge.items.push(item);
      newItems.push(item);
      await markSeen(id);
    }
  }

  // YouTube playlists
  if (sources.youtube?.playlists) {
    for (const p of sources.youtube.playlists) {
      const id = `yt-playlist-${p.id}`;
      if (p.mode === "once" && progress.seen[id]) continue;

      const item = {
        id,
        title: `YouTube playlist ${p.id}`,
        url: `https://www.youtube.com/playlist?list=${p.id}`,
        sourceType: "youtube-playlist",
        collectedAt: new Date().toISOString()
      };

      knowledge.items.push(item);
      newItems.push(item);
      await markSeen(id);
    }
  }

  // YouTube channels (windowed)
  if (sources.youtube?.channels) {
    for (const ch of sources.youtube.channels) {
      const id = `yt-channel-${ch.handle}-${new Date().toISOString().split("T")[0]}`;
      if (progress.seen[id]) continue;

      const item = {
        id,
        title: `YouTube channel ${ch.handle}`,
        url: `https://youtube.com/@${ch.handle}`,
        sourceType: "youtube-channel",
        collectedAt: new Date().toISOString()
      };

      if (withinWindow(item.collectedAt, sources.youtube.defaultWindow ?? "1d")) {
        knowledge.items.push(item);
        newItems.push(item);
        await markSeen(id);
      }
    }
  }

  if (newItems.length) {
    await pushUpdate(knowledge, `Ingest ${newItems.length} new items`);
    console.log(`Ingest saved ${newItems.length} new items`);
  } else {
    console.log("No new items ingested");
  }

  return { count: newItems.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch(err => {
    console.error("Ingest failed", err);
    process.exitCode = 1;
  });
}

