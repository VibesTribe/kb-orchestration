const DEFAULT_MODELS = [
  "xai/grok-4-f",
  "deepseek/deepseek-v3.1",
  "nvidia/nemotron-nano-9b-v2",
  "mistralai/mistral-7b-instruct:latest"
];

const OPENROUTER_REFERRER = process.env.OPENROUTER_REFERRER ?? "https://github.com/VibesTribe/kb-orchestration";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE ?? "kb-orchestration";

function unique(array) {
  return [...new Set(array.filter(Boolean))];
}

export async function callOpenRouter(messages, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const explicitModel = options.model ? [options.model] : [];
  const primaryEnv = process.env.OPENROUTER_MODEL
    ? process.env.OPENROUTER_MODEL.split(",").map((m) => m.trim())
    : [];
  const chainEnv = process.env.OPENROUTER_MODEL_CHAIN
    ? process.env.OPENROUTER_MODEL_CHAIN.split(",").map((m) => m.trim())
    : [];

  const modelChain = unique([...explicitModel, ...primaryEnv, ...chainEnv, ...DEFAULT_MODELS]);

  let lastError;
  for (const model of modelChain) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": OPENROUTER_REFERRER,
          "X-Title": OPENROUTER_TITLE
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options.maxTokens ?? 220,
          temperature: options.temperature ?? 0.2
        })
      });

      if (!response.ok) {
        lastError = new Error(`Model ${model} failed: ${response.status} ${await response.text()}`);
        continue;
      }

      const json = await response.json();
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        lastError = new Error(`Model ${model} returned empty content`);
        continue;
      }

      return { content, model, raw: json };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("All OpenRouter models failed");
}
