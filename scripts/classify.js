// scripts/classify.js
import { loadJson, saveJsonCheckpoint, ensureDir, listDirectories } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";
import { callOpenRouter } from "./lib/openrouter.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "cache");
const CLASSIFY_STATE = path.join(CACHE, "classify-state.json");
const KNOW_FILE = path.join(DATA, "knowledge.json");
const PROJECTS = path.join(ROOT, "projects");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, ctx);
}

async function loadKnowledge() {
  const obj = await loadJson(KNOW_FILE, { items: [] });
  if (!Array.isArray(obj.items)) obj.items = [];
  return obj;
}

async function saveKnowledge(knowledge) {
  await ensureDir(path.dirname(KNOW_FILE));
  await saveJsonCheckpoint(KNOW_FILE, knowledge);
  await pushUpdate(KNOW_FILE, "knowledge.json", "Classify update");
}

async function loadState() {
  await ensureDir(path.dirname(CLASSIFY_STATE));
  const obj = await loadJson(CLASSIFY_STATE, { processedIds: [] });
  if (!Array.isArray(obj.processedIds)) obj.processedIds = [];
  return obj;
}

async function saveState(state) {
  await ensureDir(path.dirname(CLASSIFY_STATE));
  await saveJsonCheckpoint(CLASSIFY_STATE, state);
}

async function loadActiveProjects() {
  const dirs = await listDirectories(PROJECTS);
  const ret = [];
  for (const d of dirs) {
    const config = await loadJson(path.join(PROJECTS, d, "project.json"), null);
    if (config && config.active !== false) {
      ret.push({ key: d, name: config.name, usefulnessCriteria: config.usefulnessCriteria });
    }
  }
  return ret;
}

export async function classify() {
  log("Starting classify...");
  const knowledge = await loadKnowledge();
  const state = await loadState();
  const projects = await loadActiveProjects();

  let processed = 0;
  let skipped = 0;

  for (const item of knowledge.items) {
    if (state.processedIds.includes(item.id)) {
      skipped++;
      continue;
    }

    if (!item.summary) {
      // can't classify if no summary
      state.processedIds.push(item.id);
      continue;
    }

    const assignments = [];

    for (const project of projects) {
      try {
        const { text, model } = await callOpenRouter(
          `Classify this item for project ${project.name}. Summary: ${item.summary}`
        );
        const parsed = JSON.parse(text);
        if (parsed.usefulness === "HIGH" || parsed.usefulness === "MODERATE") {
          assignments.push({
            projectKey: project.key,
            project: project.name,
            usefulness: parsed.usefulness,
            reason: parsed.reason || "",
            nextSteps: parsed.nextSteps || "",
            model,
          });
        }
      } catch (err) {
        log("Project classification failed", { project: project.key, error: err.message });
      }
    }

    if (assignments.length > 0) {
      item.projects = assignments;
      processed++;
    } else {
      // no relevant project
    }

    state.processedIds.push(item.id);
    await saveKnowledge(knowledge);
    await saveState(state);
    log("Classified item", { id: item.id, projects: assignments.map(a => a.projectKey) });
  }

  log("Classify done", { total: knowledge.items.length, processed, skipped });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("classify failure", err);
    process.exit(1);
  });
}
