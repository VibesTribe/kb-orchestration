// scripts/lib/state.js
// Tracks long-term pipeline state (e.g., what has already been ingested)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const PROGRESS_FILE = path.join(ROOT_DIR, "projects", "vibeflow", "progress.json");

/**
 * Load the current progress.json (safe if missing).
 */
export async function loadProgress() {
  try {
    const raw = await fs.readFile(PROGRESS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { seen: {} }; // default structure
  }
}

/**
 * Save progress.json to disk.
 */
export async function saveProgress(data) {
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(PROGRESS_FILE, json, "utf8");
}

/**
 * Mark an item as seen.
 */
export async function markSeen(id) {
  const state = await loadProgress();
  state.seen[id] = new Date().toISOString();
  await saveProgress(state);
}
