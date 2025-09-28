// scripts/lib/deepseek.js
// Minimal DeepSeek Chat helper (direct).
// Returns { text, model, tokens, rawUsage } with provider metadata.

import fetch from "node-fetch";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.warn("DEEPSEEK_API_KEY not set; DeepSeek direct calls will fail over to other providers.");
}

export async function callDeepSeek(prompt, {
  model = "deepseek-chat",
  temperature = 0.2
} = {}) {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
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
    throw new Error(`DeepSeek ${model} error: ${res.status} ${res.statusText}${t ? ` – ${t.slice(0, 400)}` : ""}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
  const usage = data?.usage ?? {};
  const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  return { text, model, tokens, rawUsage: { ...usage, provider: "deepseek" } };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
