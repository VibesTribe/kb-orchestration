// scripts/lib/openrouter.js
// Stage-specific OpenRouter rotation with real usage passthrough.
// Returns { text, model, tokens, rawUsage, provider }

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

// Cache of config + per-stage round-robin pointers
let configCache = null;
const rrIndex = new Map(); // stage -> index

async function loadConfig() {
  if (configCache) return configCache;
  const raw = await fs.readFile(MODELS_PATH, "utf8");
  configCache = JSON.parse(raw);
  return configCache;
}

function pickListForStage(cfg, stage) {
  // Prefer explicit stage list; fall back to generic "models"
  const list = Array.isArray(cfg?.[stage]) ? cfg[stage]
             : Array.isArray(cfg?.models) ? cfg.models
             : null;
  if (!list || !list.length) {
    throw new Error(`No models configured for stage "${stage}" in config/models.json`);
  }
  // Filter out our sentinel (not a real model on OpenRouter)
  return list.filter(m => m !== "openrouter/rotation");
}

export async function callWithRotation(prompt, stage = "enrich") {
  const cfg = await loadConfig();
  const models = pickListForStage(cfg, stage);

  const start = rrIndex.get(stage) ?? 0;
  rrIndex.set(stage, (start + 1) % models.length);

  for (let i = 0; i < models.length; i++) {
    const model = models[(start + i) % models.length];
    try {
      const { text, rawUsage, provider } = await callOpenRouter(model, prompt);
      const usage = rawUsage ?? {};
      const tokens = {
        prompt: usage.prompt_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        total: usage.total_tokens ?? 0,
      };

      // 🔍 Debug log: which provider actually handled the request
      console.log(`[openrouter] ${stage} → ${model} (provider: ${provider || "unknown"})`);

      return { text, model, tokens, rawUsage: usage, provider };
    } catch (err) {
