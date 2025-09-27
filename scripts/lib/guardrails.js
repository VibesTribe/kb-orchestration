import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "data");
const KNOWLEDGE_FILE = path.join(ROOT, "knowledge.json");

const CAPS = {
  openai: Number(process.env.MAX_OPENAI_CALLS_PER_RUN ?? 100),
  gemini: Number(process.env.MAX_GEMINI_CALLS_PER_RUN ?? 500),
  deepseek: Number(process.env.MAX_DEEPSEEK_SPEND ?? 2),
  openrouter: Number(process.env.MAX_OPENROUTER_SPEND ?? 5),
};

const SAFE_MODELS = new Set([
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-4.0-mini",
  "gemini-2.5-flash-lite",
  "deepseek-chat",
  // allow the OpenRouter rotating wrapper explicitly
  "rotation",
]);

let usage = { openai: 0, gemini: 0, deepseek: 0, openrouter: 0 };

async function loadKnowledge() {
  try {
    return JSON.parse(await fs.readFile(KNOWLEDGE_FILE, "utf8"));
  } catch {
    return [];
  }
}
async function saveKnowledge(data) {
  await fs.writeFile(KNOWLEDGE_FILE, JSON.stringify(data, null, 2), "utf8");
}

function ensureSafeModel(model) {
  if (!SAFE_MODELS.has(model)) {
    throw new Error(`❌ Unsafe model requested: ${model}`);
  }
}
function checkCaps(provider, estCost = 0) {
  if (provider === "openai" && usage.openai >= CAPS.openai) return false;
  if (provider === "gemini" && usage.gemini >= CAPS.gemini) return false;
  if (provider === "deepseek" && usage.deepseek + estCost > CAPS.deepseek) return false;
  if (provider === "openrouter" && usage.openrouter + estCost > CAPS.openrouter) return false;
  return true;
}
function recordUsage(provider, estCost = 0) {
  if (provider in usage) usage[provider] += estCost || 1;
}

/**
 * Safely wrap any API call with guardrails.
 * @param {Object} options
 * @param {"openai"|"gemini"|"deepseek"|"openrouter"} options.provider
 * @param {string} options.model - Must be in SAFE_MODELS
 * @param {function} options.fn - Async function that performs the actual call
 * @param {number} [options.estCost=0]
 */
export async function safeCall({ provider, model, fn, estCost = 0 }) {
  ensureSafeModel(model);
  if (!checkCaps(provider, estCost)) {
    console.log(`⚠️ Skipped ${provider}/${model} (cap reached)`);
    return null;
  }
  const result = await fn();
  recordUsage(provider, estCost);
  return result;
}

/**
 * Process a knowledge item incrementally (unchanged scaffolding)
 */
export async function processItem(item, { summarize, classify }) {
  const kb = await loadKnowledge();

  if (!item.summary) {
    item.summary = await summarize(item.text);
    item.status = "summarized";
    await saveKnowledge([...kb.filter(x => x.id !== item.id), item]);
  }

  if (!item.classification) {
    item.classification = await classify(item.summary);
    item.status = "classified";
    await saveKnowledge([...kb.filter(x => x.id !== item.id), item]);
  }

  item.status = "done";
  await saveKnowledge([...kb.filter(x => x.id !== item.id), item]);
  return item;
}
