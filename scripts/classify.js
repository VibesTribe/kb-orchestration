// scripts/classify.js
// Incremental classification of items into active projects
// Uses project-specific usefulness criteria, checkpointed by item ID.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJsonCheckpoint, ensureDir, listDirectories } from "./lib/utils.js";
import { pushUpdate } from "./lib/kb-sync.js";
import { callOpenRouter } from "./lib/openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA, "cache");
const CLASSIFY_STATE_FILE = path.join(CACHE_DIR, "classify-state.json");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const PROJECTS_ROOT = path.join(ROOT, "projects");

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

async function loadKnowledge() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  if (!Array.isArray(knowledge.items)) knowledge.items = [];
  return knowledge;
}

async function saveKnowledge(knowledge) {
  await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
  await pushUpdate(KNOWLEDGE_FILE, "knowledge.json", "Incremental classify update");
}

async function loadClassifyState() {
  await ensureDir(CACHE_DIR);
  const state = await loadJson(CLASSIFY_STATE_FILE, { processedIds: [] });
  if (!Array.isArray(state.processedIds)) state.processedIds = [];
  return state;
}

async function saveClassifyState(state) {
  await saveJsonCheckpoint(CLASSIFY_STATE_FILE, state);
}

async function loadProjects() {
  const dirs = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of dirs) {
    const configPath = path.join(PROJECTS_ROOT, dir, "project.json");
    const config = await loadJson(configPath, null);
    if (!config) continue;
    if (config.active === false) continue; // skip inactive
    projects.push({ key: dir, ...config });
  }
  return projects;
}

async function classifyItem(item, projects) {
  const assignments = [];

  for (const project of projects) {
    // Build prompt
    const prompt = `
You are classifying a knowledge item for a project.
Project: ${project.name}
Summary: ${item.summary || item.description || item.title}
Usefulness criteria: ${project.usefulnessCriteria || "Not provided"}

Decide usefulness: HIGH, MODERATE, or IRRELEVANT.
If HIGH or MODERATE, give a short reason and a next step for the project.
Return JSON with {usefulness, reason, nextSteps}.
`;

    try {
      const result = await callOpenRouter(project.classifyModel || "openrouter/gpt-4o-mini", prompt);
      const parsed = JSON.parse(result.text);

      if (parsed.usefulness === "HIGH" || parsed.usefulness === "MODERATE") {
        assignments.push({
          projectKey: project.key,
          project: project.name,
          usefulness: parsed.usefulness,
          reason: parsed.reason || "",
          nextSteps: parsed.nextSteps || ""
        });
      }
    } catch (err) {
      log("Classification failed", { project: project.key, error: err.message });
    }
  }

  return assignments;
}

export async function classify() {
  log("Starting classify...");

  const knowledge = await loadKnowledge();
  const state = await loadClassifyState();
  const projects = await loadProjects();

  if (!projects.length) {
    log("No active projects, skipping classification.");
    return;
  }

  let processed = 0;
  let skipped = 0;

  for (const item of knowledge.items) {
    if (state.processedIds.includes(item.id)) {
      skipped++;
      continue;
    }

    const assignments = await classifyItem(item, projects);
    if (assignments.length > 0) {
      item.projects = assignments;
      processed++;
      state.processedIds.push(item.id);
      await saveKnowledge(knowledge); // save after each item
      await saveClassifyState(state);
      log("Classified item", { id: item.id, projects: assignments.map(a => a.projectKey) });
    } else {
      state.processedIds.push(item.id); // mark done even if irrelevant
      await saveClassifyState(state);
      skipped++;
    }
  }

  log("Classify step complete", { total: knowledge.items.length, processed, skipped });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify step failed", err);
    process.exit(1);
  });
}
