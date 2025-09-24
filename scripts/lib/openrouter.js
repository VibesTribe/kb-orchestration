// scripts/lib/openrouter.js
import fetch from "node-fetch";
import { loadJson } from "./utils.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.warn("Warning: OPENROUTER_API_KEY not set!");
}

/**
 * Try to call OpenRouter with a given model and prompt
 * Returns { text, model } or throws error.
 */
export async function callOpenRouterModel(model, prompt, options = {}) {
  const body = {
    model,
    prompt,
    // ... other options or settings
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      // Add any required headers (e.g. OpenRouter’s policy headers)
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenRouter ${model} failed: ${resp.status} ${txt}`);
  }

  const j = await resp.json();
  const resultText = j.choices?.[0]?.message?.content;
  if (typeof resultText !== "string") {
    throw new Error(`OpenRouter ${model} returned no content`);
  }

  return { text: resultText, model };
}

/**
 * Rotate through configured models until one succeeds.
 * Reads model list from config/models.json under key "models".
 */
export async function callOpenRouter(prompt, options = {}) {
  const cfg = await loadJson("config/models.json", null);
  const models = (cfg && Array.isArray(cfg.models)) ? cfg.models : [];
  if (!models.length) {
    throw new Error("No models configured in config/models.json");
  }

  let lastError = null;
  for (const m of models) {
    try {
      const res = await callOpenRouterModel(m, prompt, options);
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`Model ${m} failed: ${err.message}`);
      continue;
    }
  }
  // All models failed
  throw lastError;
}
