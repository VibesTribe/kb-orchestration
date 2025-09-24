// scripts/enrich.js
// Incremental enrichment of data/knowledge.json items using OpenRouter.
// Saves state to data/cache/enrich-state.json so partial runs are preserved.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./lib/openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_DIR, "enrich-state.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${payload}`);
}

async function loadState() {
  return loadJson(STATE_FILE, { enrichedIds: [] });
}

async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

function identifierFor(item) {
  // Some sources use id, some canonicalId — normalize
  return item.id ?? item.canonicalId ?? item.url ?? JSON.stringify(item).slice(0, 64);
}

// Build a friendly prompt/messages for the LLM
function buildMessages(item, projectHints = "") {
  const system = {
    role: "system",
    content: `You are a concise summarization assistant. Produce a short summary (one paragraph, max 2-3 sentences) and a slightly longer description (3-6 sentences) that explains usefulness and actionable next steps.`
  };

  const userParts = [
    `Title: ${item.title ?? "(untitled)"}`,
    item.summary ? `Existing summary: ${item.summary}` : "",
    item.description ? `Existing description: ${item.description}` : "",
    item.url ? `URL: ${item.url}` : "",
    projectHints ? `Project hints: ${projectHints}` : ""
  ].filter(Boolean).join("\n\n");

  const user = {
    role: "user",
    content: `Create:\n1) A short 'summary' (1 paragraph) suitable for quick digest.\n2) A 'description' (3-6 sentences) suitable for indexed knowledgebase.\n\nInput:\n${userParts}`
  };

  return [system, user];
}

export async function enrich() {
  const kb = await loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });
  const state = await loadState();

  let updated = 0;
  for (const item of kb.items ?? []) {
    const id = identifierFor(item);
    if (state.enrichedIds.includes(id)) continue; // already done
    // Skip items that already have both summary and description
    if (item.summary && item.description) {
      state.enrichedIds.push(id);
      await saveState(state);
      continue;
    }

    try {
      const messages = buildMessages(item);
      // Call OpenRouter — keep it small tokens to avoid runaway consumption
      const { content, model } = await callOpenRouter(messages, { maxTokens: 400, temperature: 0.15 }).catch(err => {
        throw new Error(`OpenRouter error: ${err.message}`);
      });

      // Expect the model to return a block we can parse. We'll try simple heuristics.
      // Look for "Summary:" / "Description:" markers, otherwise split.
      let summary = "";
      let description = "";

      const lower = content.toLowerCase();
      if (lower.includes("summary") && lower.includes("description")) {
        const sMatch = content.match(/summary[:\s]*([\s\S]*?)(?=description[:\s]*|$)/i);
        const dMatch = content.match(/description[:\s]*([\s\S]*)/i);
        summary = sMatch ? sMatch[1].trim() : "";
        description = dMatch ? dMatch[1].trim() : "";
      } else {
        // fallback: first sentence(s) as summary, rest as description
        const sentences = content.split(/(?<=[.?!])\s+/);
        summary = sentences.slice(0, 1).join(" ").trim();
        description = sentences.slice(1).join(" ").trim() || content;
      }

      // Write back to item
      item.summary = item.summary || summary;
      item.description = item.description || description;
      item._enrichedBy = item._enrichedBy ?? {};
      item._enrichedBy[ (new Date()).toISOString() ] = { model };

      state.enrichedIds.push(id);
      updated++;

      // Save after each item so partial progress is preserved
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveState(state);

      log("Enriched item", { id, title: item.title, model });
    } catch (err) {
      log("Failed to enrich item", { title: item.title ?? "(untitled)", error: err.message });
      // Save state and kb to preserve what we have
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveState(state);
      // Throw so pipeline can record failure (but state saved)
      throw err;
    }
  }

  if (updated === 0) {
    log("No items needed enrichment");
  } else {
    log(`Enriched ${updated} item(s)`);
  }
}

// Run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch(err => {
    console.error("Enrich failed", err);
    process.exitCode = 1;
  });
}
