// scripts/lib/gemini.js
import fetch from "node-fetch";

const GEMINI_API = process.env.GEMINI_API;
if (!GEMINI_API) {
  throw new Error("GEMINI_API is required");
}

/**
 * Call Gemini API for a summary.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function callGemini(prompt) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}
