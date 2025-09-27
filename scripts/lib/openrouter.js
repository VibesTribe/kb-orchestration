// scripts/lib/openrouter.js
// Unified model caller with round-robin fallback.
// Supports stage-specific model lists (enrich vs classify).
// Routes OpenAI + Gemini models to their native APIs,
// everything else goes through OpenRouter.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const MODELS_PATH = path.join(ROOT_DIR, "config", "models.json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is required");
}

let modelsConfig = null;
let roundRobinIndices = { enrich: 0, classify: 0 };

// --- Load model config once ---
async function loadModels() {
  if (modelsConfig) return modelsConfig;
  const text = await fs.readFile(MODELS_PATH, "utf8");
  const json = JSON.parse(text);
  if (!json.enrich || !json.classify) {
    throw new Error("config/models.json must contain 'enrich' and 'classify' arrays");
  }
  modelsConfig = json;
  return modelsConfig;
}

// --- OpenAI direct call ---
async function callDirectOpenAI(model, prompt) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    tokens: data.usage?.total_tokens ?? 0
  };
}

// --- Gemini direct call ---
async function callDirectGemini(model, prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    })
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { text, tokens: 0 }; // Gemini rarely returns usage
}

// --- OpenRouter call ---
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

  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  const tokens = data.usage?.total_tokens ?? 0;
  return { text, tokens };
}

// --- Router ---
async function callModel(model, prompt) {
  if (model.startsWith("openai/")) {
    return callDirectOpenAI(model.replace("openai/", ""), prompt);
  }
  if (model.startsWith("gemini/")) {
    return callDirectGemini(model.replace("gemini/", ""), prompt);
  }
  return callOpenRouter(model, prompt);
}

// --- Round robin rotation (stage-specific) ---
export async function callWithRotation(prompt, stage = "enrich") {
  const cfg = await loadModels();
  const modelList = cfg[stage];
  if (!modelList || !modelList.length) {
    throw new Error(`No models configured for stage '${stage}'`);
  }

  let index = roundRobinIndices[stage];
  const startIndex = index;
  roundRobinIndices[stage] = (index + 1) % modelList.length;

  for (let i = 0; i < modelList.length; i++) {
    const model = modelList[(startIndex + i) % modelList.length];
    try {
      const result = await callModel(model, prompt);
      return { ...result, model };
    } catch (err) {
      console.warn(`[openrouter] ${stage} failed with ${model}: ${err.message}`);
    }
  }

  throw new Error(`All models failed for stage '${stage}'`);
}
