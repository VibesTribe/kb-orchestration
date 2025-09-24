// scripts/classify.js
// Classify curated items against projects and push upstream as we go.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pushUpdate } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const STATE_FILE = path.join(ROOT_DIR, "data", "cache", "classify-state.json");

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function loadKnowledge() {
  return fetch("https://raw.githubusercontent.com/VibesTribe/knowledgebase/main/knowledge.json")
    .then(r => r.json())
    .catch(() => ({ items: [] }));
}

function normalize(item) {
  return [item.title ?? "", item.summary ?? "", item.description ?? ""].join("\n").toLowerCase();
}

export async function classify() {
  const knowledge = await loadKnowledge();
  const state = await loadJson(STATE_FILE, { done: [] });

  let changed = 0;
  for (const item of knowledge.items ?? []) {
    const id = item.id ?? item.url;
    if (!id || state.done.includes(id)) continue;

    // TODO: hook project criteria here. For now mark archive.
    item.projects = [{ project: "vibeflow", usefulness: "archive" }];

    state.done.push(id);
    changed++;
    await saveJson(STATE_FILE, state);
    await pushUpdate(knowledge, `Classify item ${id}`);
    console.log("Classified", id);
  }
  return { count: changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch(e => { console.error(e); process.exitCode = 1; });
}

