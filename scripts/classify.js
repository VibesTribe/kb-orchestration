// scripts/classify.js
// Classification flow using per-item fail-fast and provider rotation.
// Priority per item: OpenAI (direct) → Gemini (direct) → OpenRouter → DeepSeek (direct).
// Stores results incrementally to knowledge.json after each project classification.
// Uses fullSummary (preferred) for richer signal; falls back to summary/description/title.
//
// Env needed (all optional except OpenRouter when used):
// - OPENAI_API_KEY
// - GEMINI_API or GEMINI_API_KEY (used via lib/gemini.js)
// - OPENROUTER_API_KEY (for OpenRouter fallback)
// - DEEPSEEK_API_KEY (direct fallback, last resort)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

import { callWithRotation } from "./lib/openrouter.js";
import { callGemini } from "./lib/gemini.js";
import { loadJson, saveJsonCheckpoint } from "./lib/utils.js";
import { logStageUsage } from "./lib/token-usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_FILE = path.join(ROOT, "data", "knowledge.json");
const STATE_FILE = path.join(ROOT, "data/cache/classify-state.json");
const PROJECTS_DIR = path.join(ROOT, "projects");

// ---- Direct provider env ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

// ---------- Logging ----------
function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(ctx).length ? ctx : "");
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
    text:
      (full && String(full)) ||
      (brief && String(brief)) ||
      (desc && String(desc)) ||
      ""
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

// ---------- Direct provider callers (inline to avoid new files) ----------
async function callOpenAIChat(prompt, models = ["gpt-4o-mini", "gpt-4.0-mini", "gpt-5-mini"]) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2
        })
      });
      if (!res.ok) {
        const t = await safeText(res);
        throw new Error(`OpenAI ${model} error: ${res.status} ${res.statusText}${t ? ` – ${t.slice(0, 400)}` : ""}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
      const usage = data?.usage ?? {};
      return { text, model, rawUsage: usage };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("OpenAI call failed");
}

async function callDeepSeekChat(prompt, model = "deepseek-chat") {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });
  if (!res.ok) {
    const t = await safeText(res);
    throw new Error(`DeepSeek error: ${res.status} ${res.statusText}${t ? ` – ${t.slice(0, 400)}` : ""}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
  const usage = data?.usage ?? {};
  return { text, model, rawUsage: usage };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
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
    if (state.processed.includes(item.id)) continue;

    let anySuccessForItem = false;

    try {
      item.projects = Array.isArray(item.projects) ? item.projects : [];

      for (const project of activeProjects) {
        const already = item.projects.find(
          (x) => x.projectKey === project.key || x.project === project.name
        );
        if (already) continue;

        const prompt = buildPrompt({ project, item });

        // Priority: OpenAI → Gemini → OpenRouter → DeepSeek
        let text = "";
        let model = "";
        let rawUsage = null;

        try {
          const r = await callOpenAIChat(prompt);
          text = r.text; model = r.model; rawUsage = r.rawUsage ?? null;
          log("Used OpenAI for classify", { id: item.id, project: project.name, model });
        } catch (e1) {
          log("OpenAI failed; fallback to Gemini", { id: item.id, project: project.name, error: e1.message });
          try {
            const r = await callGemini(prompt); // gemini-2.5-flash-lite via lib
            text = r.text; model = r.model; rawUsage = { total_tokens: r.tokens ?? 0 };
            log("Used Gemini for classify", { id: item.id, project: project.name, model });
          } catch (e2) {
            log("Gemini failed; fallback to OpenRouter", { id: item.id, project: project.name, error: e2.message });
            try {
              const r = await callWithRotation(prompt, "classify");
              text = r.text; model = r.model; rawUsage = r.rawUsage ?? null;
              log("Used OpenRouter for classify", { id: item.id, project: project.name, model });
            } catch (e3) {
              log("OpenRouter failed; fallback to DeepSeek (direct)", { id: item.id, project: project.name, error: e3.message });
              const r = await callDeepSeekChat(prompt, "deepseek-chat");
              text = r.text; model = r.model; rawUsage = r.rawUsage ?? null;
              log("Used DeepSeek direct for classify", { id: item.id, project: project.name, model });
            }
          }
        }

        if (!validClassificationText(text)) {
          log("Invalid classification output; marking LOW", { id: item.id, project: project.name, model });
        }

        const usefulness = parseUsefulness(text);
        const reason = extractReason(text);
        const nextSteps = extractNextSteps(text);

        item.projects.push({
          project: project.name,
          projectKey: project.key,
          usefulness,
          reason,
          nextSteps,
          modelUsed: model
        });

        await logStageUsage("classify", model, prompt, text, item.id, rawUsage);

        // Save after each project classification
        await saveJsonCheckpoint(KNOWLEDGE_FILE, knowledge);
        await saveJsonCheckpoint(STATE_FILE, state);

        classifiedCount++;
        anySuccessForItem = true;
        log("Classified item", { id: item.id, project: project.name, model });
      }

      // Mark item as fully processed only after iterating projects
      state.processed.push(item.id);
      await saveJsonCheckpoint(STATE_FILE, state);
    } catch (err) {
      log("Failed to classify item", { id: item.id, error: err.message });
    }

    // Fail-fast handling (per-item)
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
