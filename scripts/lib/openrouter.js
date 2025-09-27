// scripts/lib/openrouter.js
// Call OpenRouter models with round-robin fallback.
// Returns { text, model, tokens, usage }

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

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
  const text = await fs.readFile(MODELS_PATH, "utf8");
  const json = JSON.parse(text);
  if (!json.models || !Array.isArray(json.models)) {
    throw new Error("config/models.json must have a 'models' array");
  }
  models = json.models;
  return models;
}

export async function callWithRotation(prompt, purpose = "enrich") {
  const modelList = await loadModels();
  if (!modelList.length) throw new Error("No models in config/models.json");

  const startIndex = roundRobinIndex;
  roundRobinIndex = (roundRobinIndex + 1) % modelList.length;

  for (let i = 0; i < modelList.length; i++) {
    const model = modelList[(startIndex + i) % modelList.length];
    try {
      const result = await callOpenRouter(model, prompt);
      return { ...result, model };
    } catch (err) {
      console.warn(`[openrouter] ${purpose} failed with ${model}: ${err.message}`);
    }
  }

  throw new Error(`All OpenRouter models failed for ${purpose}`);
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
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";

  // ✅ Try to capture real usage if available
  const usage = data.usage ?? {};
  const tokens = {
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? 0,
  };

  return { text, tokens, usage };
}
