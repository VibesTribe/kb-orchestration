import { safeCall, processItem } from "../guardrails.js";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function summarize(text) {
  return safeCall({
    provider: "openai",
    model: "gpt-5-mini", // ✅ explicit safe model
    estCost: 0.0001,
    fn: async () => {
      const res = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: `Summarize: ${text}` }],
      });
      return res.choices[0].message.content;
    },
  });
}

async function classify(summary) {
  return safeCall({
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    fn: async () => {
      // …call Gemini API…
      return "Vibeflow"; // placeholder
    },
  });
}

// Example usage:
const item = { id: "123", text: "Transcript text..." };
await processItem(item, { summarize, classify });
