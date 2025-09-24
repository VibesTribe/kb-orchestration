// scripts/lib/openrouter.js
// Lightweight OpenRouter client — uses global fetch (Node 18+/20+).
// Exports callOpenRouter(messages, options)

const DEFAULT_MODEL_CHAIN = [
  "xai/grok-4-f",
  "deepseek/deepseek-v3.1",
  "nvidia/nemotron-nano-9b-v2",
  "mistralai/mistral-7b-instruct:latest"
];

const REFERRER = process.env.OPENROUTER_REFERRER ?? "https://github.com/VibesTribe/kb-orchestration";
const TITLE = process.env.OPENROUTER_TITLE ?? "kb-orchestration";

export async function callOpenRouter(messages, { model, maxTokens = 220, temperature = 0.2 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  // Build chain: explicit model first, then env chain (if set), then defaults
  const explicit = model ? [model] : [];
  const primaryEnv = process.env.OPENROUTER_MODEL ? process.env.OPENROUTER_MODEL.split(",").map(s => s.trim()).filter(Boolean) : [];
  const chainEnv = process.env.OPENROUTER_MODEL_CHAIN ? process.env.OPENROUTER_MODEL_CHAIN.split(",").map(s => s.trim()).filter(Boolean) : [];

  const modelChain = [...new Set([...explicit, ...primaryEnv, ...chainEnv, ...DEFAULT_MODEL_CHAIN])];

  let lastError = null;
  for (const m of modelChain) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": REFERRER,
          "X-Title": TITLE
        },
        body: JSON.stringify({
          model: m,
          messages,
          max_tokens: maxTokens,
          temperature
        })
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "<no body>");
        lastError = new Error(`Model ${m} failed: ${res.status} ${body}`);
        continue;
      }

      const json = await res.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        lastError = new Error(`Model ${m} returned empty content`);
        continue;
      }

      return { content, model: m, raw: json };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("All OpenRouter attempts failed");
}
