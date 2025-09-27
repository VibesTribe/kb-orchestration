// scripts/lib/openrouter.js
// Call OpenRouter models with round-robin fallback.
// Returns { text, model, tokens }

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

let modelConfig = null;
let roundRobinIndices = {}; // track separately for enrich, classify, etc.

async function loadModelsConfig() {
  if (modelConfig) return modelConfig;
  const text = await fs.readFile(MODELS_PATH, "utf8");
  modelConfig = JSON.parse(text);
  return modelConfig;
}

export async function callWithRotation(prompt, purpose = "enrich") {
  const config = await loadModelsConfig();

  // Support both old and new shapes of models.json
  let modelList = [];
  if (Array.isArray(config.models)) {
    modelList = config.models;
  } else if (Array.isArray(config[purpose])) {
    modelList = config[purpose];
  }

  if (!modelList.length) {
    throw new Error(`No models defined for purpose '${purpose}' in config/models.json`);
  }

  // Round robin index per purpose
  if (!(purpose in roundRobinIndices)) roundRobinIndices[purpose] = 0;
  const startIndex = roundRobinIndices[purpose];
  roundRobinIndices[purpose] = (startIndex + 1) % modelList.length;

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
  const tokens = data.usage?.total_tokens ?? 0; // fallback if usage missing
  return { text, tokens };
}
