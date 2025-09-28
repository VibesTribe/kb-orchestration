// scripts/lib/gemini.js
// Minimal Gemini API helper (direct).
// Returns { text, model, tokens }.

import fetch from "node-fetch";

// Allow either GEMINI_API or GEMINI_API_KEY (you have GEMINI_API in Actions)
const GEMINI_API = process.env.GEMINI_API || process.env.GEMINI_API_KEY;
if (!GEMINI_API) {
  throw new Error("GEMINI_API is required");
}

// Stable model ID per your spec
const GEMINI_MODEL = "gemini-2.5-flash-lite";

export async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${res.statusText} ${msg}`);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "(no output)";
  const tokens = data?.usageMetadata?.totalTokenCount ?? 0;
  return { text, model: GEMINI_MODEL, tokens };
}
