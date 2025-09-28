// scripts/lib/gemini.js
// Minimal Gemini API helper
// Returns { text, model, tokens }

import fetch from "node-fetch";

const GEMINI_API = process.env.GEMINI_API || process.env.GEMINI_API_KEY;

if (!GEMINI_API) {
  console.error("DEBUG: GEMINI_API is missing or empty.");
  throw new Error("GEMINI_API is required");
} else {
  // Masked debug: show only first 3 chars and total length
  const masked =
    GEMINI_API.length > 3
      ? GEMINI_API.slice(0, 3) + "..." + ` (len=${GEMINI_API.length})`
      : `(len=${GEMINI_API.length})`;
  console.error("DEBUG: GEMINI_API detected:", masked);
}

export async function callGemini(prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent",
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
  return { text, model: "gemini-1.5-flash-latest", tokens };
}
