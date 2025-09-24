import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const MODELS_PATH = path.join(ROOT_DIR, "config", "models.json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is required");
}

let models = [];
let roundRobinIndex = 0;

async function loadModels() {
  if (models.length) return models;
  try {
    const text = await fs.readFile(MODELS_PATH, "utf8");
    const json = JSON.parse(text);
    if (!json.models || !Array.isArray(json.models)) {
      throw new Error("config/models.json must have a 'models' array");
    }
    models = json.models;
    return models;
  } catch (err) {
    console.error("Failed to load models.json", err);
    throw err;
  }
}

/**
 * Call OpenRouter with round-robin + fallback through configured models.
 * @param {string} prompt
 * @param {string} purpose - "enrich" | "classify"
 * @returns {Promise<{text: string, model: string}>}
 */
export async function callWithRotation(prompt, purpose = "enrich") {
  const modelList = await loadModels();
  if (!modelList.length) {
    throw new Error("No models available in config/models.json");
  }

  // pick starting index for this item
  const startIndex = roundRobinIndex;
  roundRobinIndex = (roundRobinIndex + 1) % modelList.length;

  // try each model in sequence, starting from startIndex
  for (let i = 0; i < modelList.length; i++) {
    const model = modelList[(startIndex + i) % modelList.length];
    try {
      const result = await callOpenRouter(model, prompt);
      return { text: result, model };
    } catch (err) {
      console.warn(`[openrouter] ${purpose} failed with ${model}: ${err.message}`);
    }
  }

  throw new Error(`All models failed for ${purpose} (tried ${modelList.length} models)`);
}

async function callOpenRouter(model, prompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
