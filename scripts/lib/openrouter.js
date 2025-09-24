import fetch from "node-fetch";

const DEFAULT_MODEL_CHAIN = [
  "xai/grok-4-f",
  "deepseek/deepseek-v3.1",
  "nvidia/nemotron-nano-9b-v2",
  "mistralai/mistral-7b-instruct:latest"
];

const REFERRER = "https://github.com/VibesTribe/kb-orchestration";
const TITLE = "kb-orchestration";

export async function callOpenRouter(messages, { model, maxTokens = 220, temperature = 0.2 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  const chain = model ? [model, ...DEFAULT_MODEL_CHAIN] : DEFAULT_MODEL_CHAIN;
  let lastErr;
  for (const m of chain) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": REFERRER,
          "X-Title": TITLE
        },
        body: JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature })
      });
      if (!res.ok) { lastErr = new Error(`Model ${m} ${res.status} ${await res.text()}`); continue; }
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) { lastErr = new Error(`Model ${m} returned empty content`); continue; }
      return { content, model: m };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All OpenRouter models failed");
}
