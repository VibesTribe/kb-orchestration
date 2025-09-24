// scripts/classify.js
// Classify items against active projects.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJsonCheckpoint, ensureDir, listDirectories } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const PROJECTS_ROOT = path.join(ROOT, "projects");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

async function loadProjects() {
  const dirs = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of dirs) {
    const configPath = path.join(PROJECTS_ROOT, dir, "project.json");
    try {
      const config = await loadJson(configPath, null);
      if (config?.active) {
        projects.push({ key: dir, ...config });
      }
    } catch {
      continue;
    }
  }
  return projects;
}

// Placeholder classification logic
function classifyItem(item, projects) {
  return projects.map((project) => ({
    projectKey: project.key,
    usefulness: "HIGH", // naive: all high
    reason: `Relevant to ${project.name}`,
    nextSteps: "Review and integrate.",
  }));
}

export async function classify() {
  log("Starting classify...");

  let knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items)) knowledge.items = [];

  const projects = await loadProjects();
  if (!projects.length) {
    log("No active projects, skipping classification.");
    return;
  }

  let processed = 0;

  for (const item of knowledge.items) {
    if (item.projects && item.projects.length) continue;

    item.projects = classifyItem(item, projects);
    item.classifiedAt = new Date().toISOString();

    // Save locally
    await ensureDir(path.dirname(KNOWLEDGE_FILE));
    await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);

    // Push upstream immediately
    await pushUpdate(KNOWLEDGE_FILE, "knowledge.json", `Classify item ${item.id}`);

    log("Classified item", { id: item.id });
    processed++;
  }

  log("Classify step complete", { total: knowledge.items.length, processed });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify step failed", err);
    process.exit(1);
  });
}
