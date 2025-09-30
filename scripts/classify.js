// scripts/classify.js
// Classification flow using per-item fail-fast and provider rotation.
// Provider priority per item: Gemini (direct) → OpenRouter (guardrailed) → DeepSeek (guardrailed).
// Stores results incrementally to knowledge.json after each project classification,
// and syncs immediately to the knowledgebase repo.
// Uses fullSummary (preferred) for richer signal; falls back to summary/description/title.
// Idempotent: if item already classified for all active projects, skip (even if cache is empty).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callWithRotation } from "./lib/openrouter.js";
import { callGemini } from "./lib/gemini.js";
// import { callOpenAI } from "./lib/openai.js"; // ⛔ disabled
import { callDeepSeek } from "./lib/deepseek.js";
import { safeCall } from "./lib/guardrails.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage } from "./lib/token-usage.js";
import { syncKnowledge } from "./lib/kb-sync.js";

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

// ---------- Throttling helper ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// Use long summary if available
function materialForItem(item) {
  const full = item.fullSummary || "";
  const brief = item.summary || "";
  const desc = item.description || "";
  const title = item.title || "(untitled)";
  const url = item.url || "";
  return {
    title,
    url,
    text: (full && String(full)) || (brief && String(brief)) || (desc && String(desc)) || ""
  };
}

function buildPrompt({ project, item }) {
  const mat = materialForItem(item);
  return `
You are classifying usefulness of an item for a specific project.

Project:
- Name: ${project.name}
- Summary: ${project.summary || "(none)"}
- Goals: ${(project.goals || []).map((g) => `- ${g}`).join("\n") || "(unspecified)"}

Item:
- Title: ${mat.title}
- URL: ${mat.url}
- Content:
${mat.text ? mat.text : "(no content, title/URL only)"}

Respond in plain text with:
1) Usefulness level: one of HIGH, MODERATE, or LOW
2) Why it matters: a single brief reason
3) Next steps: a single brief suggestion if useful

Format example:
HIGH
Why it matters: …
Next steps: …
`.trim();
}

function validClassificationText(t = "") {
  return /(HIGH|MODERATE|LOW)/i.test(t);
}

// Strong guard: is this item already classified for every active project?
function isFullyClassifiedForActiveProjects(item, activeProjects) {
  if (!Array.isArray(activeProjects) || !activeProjects.length) return true;
  const remaining = new Set(activeProjects.map((p) => p.key));
  for (const a of (item.projects || [])) {
    const key = a.projectKey || null;
    if (key && remaining.has(key) && a.usefulness) remaining.delete(key);
  }
  return remaining.size === 0;
}

function upsertProjectClassification(item, project, data) {
  item.projects = Array.isArray(item.projects) ? item.projects : [];
  const idx = item.projects.findIndex(
    (x) => x.projectKey === project.key || x.project === project.name
  );
  const payload = {
    project: project.name,
    projectKey: project.key,
    usefulness: data.usefulness,
    reason: data.reason,
    nextSteps: data.nextSteps,
    modelUsed: data.modelUsed
  };
  if (idx >= 0) {
    // Only fill missing fields; don't create duplicates
    item.projects[idx] = { ...item.projects[idx], ...payload };
  } else {
    item.projects.push(payload);
  }
}

// ---------- Main classification ----------
export async function classify(options = {}) {
  const knowledge = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { processed: [] });

  const maxConsecutiveFails = Number(options?.failFast?.maxConsecutiveFails ?? 5);
  let consecutiveFails = 0;
  let classifiedCount = 0;

  const projects = await loadProjects();
  const activeProjects = projects.filter(
    (p) => p?.status?.toLowerCase?.() === "active" || p?.active === true
  );

  for (const item of knowledge.items) {
    // Knowledge-first idempotent skip
    if (isFullyClassifiedForActiveProjects(item, activeProjects) || state.processed.includes(item.id)) {
      if (!state.processed.includes(item.id)) {
        state.processed.push(item.id);
        await saveJsonCheckpoint(STATE_FILE, state);
      }
      continue;
    }

    let anySuccessForItem = false;

    try {
      for (const project of activeProjects) {
        // Per-project skip if already classified for this project
        const existing = (item.projects || []).find(
          (x) => (x.projectKey === project.key || x.project === project.name) && x.usefulness
        );
        if (existing) continue;

        const prompt = buildPrompt({ project, item });

        // Priority: Gemini → OpenRouter (guardrailed) → DeepSeek (guardrailed)
        let text = "";
        let model = "";
        let rawUsage = null;

        try {
          const r = await callGemini(prompt);
          text = r.text; model = r.model; rawUsage = { total_tokens: r.tokens ?? 0, provider: "gemini" };
          log("Used Gemini for classify", { id: item.id, project: project.name, model });
        } catch (e2) {
          log("Gemini failed; fallback to OpenRouter", { id: item.id, project: project.name, error: e2.message });
          try {
            const r = await safeCall({
              provider: "openrouter",
              model: "rotation",
              fn: () => callWithRotation(prompt, "classify"),
              estCost: 1
            });
            if (!r) throw new Error("OpenRouter skipped (cap reached)");
            text = r.text; model = r.model; rawUsage = { ...r.rawUsage, provider: r.provider || "openrouter" };
            log("Used OpenRouter for classify", { id: item.id, project: project.name, model, provider: r.provider });
          } catch (e3) {
            log("OpenRouter failed; fallback to DeepSeek", { id: item.id, project: project.name, error: e3.message });
            const r = await safeCall({
              provider: "deepseek",
              model: "deepseek-chat",
              fn: () => callDeepSeek(prompt),
              estCost: 0.01
            });
            if (!r) throw new Error("DeepSeek skipped (cap reached)");
            text = r.text; model = r.model; rawUsage = r.rawUsage ?? null;
            log("Used DeepSeek direct for classify", { id: item.id, project: project.name, model });
          }
        }

        if (!validClassificationText(text)) {
          log("Invalid classification output; marking LOW", { id: item.id, project: project.name, model });
        }

        const usefulness = parseUsefulness(text);
        const reason = extractReason(text);
        const nextSteps = extractNextSteps(text);

        upsertProjectClassification(item, project, {
          usefulness,
          reason,
          nextSteps,
          modelUsed: model
        });

        await logStageUsage("classify", model, prompt, text, item.id, rawUsage);

        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
        await saveJsonCheckpoint(STATE_FILE, state);

        await syncKnowledge();   // push immediately
        await sleep(5000);       // throttle

        classifiedCount++;
        anySuccessForItem = true;
        log("Classified item", { id: item.id, project: project.name, model });
      }

      // If the item now has classifications for all active projects, lock it into state
      if (isFullyClassifiedForActiveProjects(item, activeProjects)) {
        if (!state.processed.includes(item.id)) {
          state.processed.push(item.id);
          await saveJsonCheckpoint(STATE_FILE, state);
        }
      }
    } catch (err) {
      log("Failed to classify item", { id: item.id, error: err.message });
    }

    if (!anySuccessForItem) {
      consecutiveFails += 1;
      if (consecutiveFails >= maxConsecutiveFails) {
        throw new Error(
          `Fail-fast: ${consecutiveFails} consecutive items failed to classify across all providers`
        );
      }
    } else {
      consecutiveFails = 0;
    }
  }

  log("Classify step complete", {
    total: knowledge.items.length,
    classified: classifiedCount
  });
}

// ---------- Entrypoint ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify step failed", err);
    process.exitCode = 1;
  });
}
