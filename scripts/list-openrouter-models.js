// scripts/list-openrouter-models.js
// Lists all models available on OpenRouter with pricing info.
// Run with: node scripts/list-openrouter-models.js

import fetch from "node-fetch";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is required");
}

async function main() {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Failed to fetch models: ${res.status} ${res.statusText} ${msg}`);
  }

  const data = await res.json();
  if (!data.data) {
    throw new Error("Unexpected response format");
  }

  console.log("📚 Available OpenRouter Models:");
  for (const m of data.data) {
    const id = m.id;
    const name = m.name || id;
    const pricing = m.pricing || {};
    const free = pricing.prompt === 0 && pricing.completion === 0;
    console.log(
      `- ${id} (${name}) | Prompt: ${pricing.prompt ?? "?"}, Completion: ${pricing.completion ?? "?"} ${free ? "✅ FREE" : ""}`
    );
  }
}

main().catch((err) => {
  console.error("Error listing models:", err);
  process.exit(1);
});
