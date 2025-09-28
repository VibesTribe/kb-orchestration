// scripts/lib/openai.js
// Minimal OpenAI Chat helper (direct).
// Returns { text, model, tokens, rawUsage } with provider metadata.

import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY not set; OpenAI direct calls will fail over to other providers.");
}

export async function callOpenAI(prompt, {
  models = ["gpt-4o-mini", "gpt-4.0-mini", "gpt-5-mini"],
  temperature = 0.2
} = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature
        }),
      });

      if (!res.ok) {
        const t = await safeText(res);
        throw new Error(`OpenAI ${model} error: ${res.status} ${res.statusText}${t ? ` – ${t.slice(0, 400)}` : ""}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
      const usage = data?.usage ?? {};
      const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
      return { text, model, tokens, rawUsage: { ...usage, provider: "openai" } };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("OpenAI call failed");
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
