import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callWithRotation } from "./lib/openrouter.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT, "data", "knowledge.json");
const STATE_FILE = path.join(ROOT, "data/cache/classify-state.json");
const PROJECTS_DIR = path.join(ROOT, "projects");

function log(msg, ctx = {}) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ctx);
}

export async function classify() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  // load active projects
  const projects = await loadProjects();
  const activeProjects = projects.filter(p => p.active);

  let classifiedCount = 0;

  for (const item of knowledge.items) {
    if (state.processed.includes(item.id)) continue;

    for (const project of activeProjects) {
      try {
        const { text, model } = await callWithRotation(
          `Classify usefulness for project: ${project.name}\n\nItem:\nTitle: ${item.title}\nSummary: ${item.summary ?? ""}\nDescription: ${item.description ?? ""}\n\nRespond with one of:\n- HIGH (critical)\n- MODERATE (useful but optional)\n- LOW (not useful)\nAlso explain why briefly, and suggest next steps if useful.`,
          "classify"
        );

        item.projects = item.projects ?? [];
        item.projects.push({
          project: project.name,
          projectKey: project.key,
          usefulness: parseUsefulness(text),
          reason: extractReason(text),
          nextSteps: extractNextSteps(text),
          modelUsed: model
        });

        state.processed.push(item.id);
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
        await saveJsonCheckpoint(STATE_FILE, state);

        log("Classified item", { id: item.id, project: project.name, model });
        classifiedCount++;
      } catch (err) {
        log("Failed to classify item", { id: item.id, project: project.name, error: err.message });
      }
    }
  }

  log("Classify step complete", { total: knowledge.items.length, classified: classifiedCount });
}

async function loadProjects() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(PROJECTS_DIR, entry.name, "project.json");
    try {
      const text = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(text);
      projects.push({ key: entry.name, ...config });
    } catch {}
  }
  return projects;
}

function parseUsefulness(text) {
  if (/high/i.test(text)) return "HIGH";
  if (/moderate/i.test(text)) return "MODERATE";
  return "LOW";
}

function extractReason(text) {
  const match = text.match(/why(?: it matters)?:?\s*(.+)/i);
  return match ? match[1].trim() : "";
}

function extractNextSteps(text) {
  const match = text.match(/next steps?:?\s*(.+)/i);
  return match ? match[1].trim() : "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch(err => {
    console.error("Classify step failed", err);
    process.exitCode = 1;
  });
}
