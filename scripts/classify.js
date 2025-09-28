// scripts/classify.js
// Classification flow using stage-specific rotation from config/models.json.
// Each item is classified per active project (HIGH / MODERATE / LOW).
// Saves incrementally after each project classification.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callWithRotation } from "./lib/openrouter.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage } from "./lib/token-usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT, "data", "knowledge.json");
const STATE_FILE = path.join(ROOT, "data/cache/classify-state.json");
const PROJECTS_DIR = path.join(ROOT, "projects");

// ---------- Logging ----------
function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
}

// ---------- Main classification ----------
export async function classify() {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  const projects = await loadProjects();
  const activeProjects = projects.filter(
    (p) => p?.status?.toLowerCase() === "active" || p?.active === true
  );

  let classifiedCount = 0;

  for (const item of knowledge.items) {
    if (state.processed.includes(item.id)) continue;

    try {
      item.projects = Array.isArray(item.projects) ? item.projects : [];

      for (const project of activeProjects) {
        const already = item.projects.find(
          (x) => x.projectKey === project.key || x.project === project.name
        );
        if (already) continue;

        const prompt = `
Classify usefulness for project: ${project.name}

Item:
Title: ${item.title ?? "(untitled)"}
Summary: ${item.summary ?? ""}
Description: ${item.description ?? ""}

Respond with:
- HIGH (critical)
- MODERATE (useful but optional)
- LOW (not useful)

Also explain why briefly, and suggest next steps if useful.
        `.trim();

        const { text, model, rawUsage } = await callWithRotation(prompt, "classify");

        item.projects.push({
          project: project.name,
          projectKey: project.key,
          usefulness: parseUsefulness(text),
          reason: extractReason(text),
          nextSteps: extractNextSteps(text),
          modelUsed: model,
        });

        // log usage
        await logStageUsage("classify", model, prompt, text, item.id, rawUsage);

        classifiedCount++;
        log("Classified item", { id: item.id, project: project.name, model });

        // save after each project classification
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
        await saveJsonCheckpoint(STATE_FILE, state);
      }

      // mark item as fully processed
      state.processed.push(item.id);
      await saveJsonCheckpoint(STATE_FILE, state);
    } catch (err) {
      log("Failed to classify item", { id: item.id, error: err.message });
    }
  }

  log("Classify step complete", {
    total: knowledge.items.length,
    classified: classifiedCount,
  });
}

// ---------- Helpers ----------
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

// ---------- Entrypoint ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify step failed", err);
    process.exitCode = 1;
  });
}
