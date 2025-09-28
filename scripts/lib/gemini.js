// scripts/lib/gemini.js
// Minimal Gemini API helper (direct).
// Returns { text, model, tokens, rawUsage } with provider metadata.

import fetch from "node-fetch";

// Allow either GEMINI_API or GEMINI_API_KEY (you set GEMINI_API in Actions)
const GEMINI_API = process.env.GEMINI_API || process.env.GEMINI_API_KEY;
if (!GEMINI_API) {
  throw new Error("GEMINI_API is required");
}

// Stable, correct model ID (avoid the old 1.5-latest name)
const GEMINI_MODEL = "gemini-2.5-flash-lite";

export async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const msg = await safeText(res);
    throw new Error(`Gemini API error: ${res.status} ${res.statusText}${msg ? ` ${msg}` : ""}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  const total = data?.usageMetadata?.totalTokenCount ?? 0;

  return {
    text,
    model: GEMINI_MODEL,
    tokens: total,
    rawUsage: { total_tokens: total, provider: "gemini" },
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
