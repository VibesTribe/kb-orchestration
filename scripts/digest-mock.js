import { renderHtmlDigest } from "./digest.js";
import "dotenv/config";

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
      to: recipients.map((email) => ({ email })),
      subject,
      textContent,
      htmlContent
    })
  });
  if (!response.ok) throw new Error(`Brevo error: ${response.status} ${await response.text()}`);
  console.log("Mock digest email sent to", recipients.join(", "));
}

// --- mock data payload ---
const payload = {
  generatedAt: new Date().toISOString(),
  subject: "Knowledgebase Digest – 1 High / 1 Moderate items",
  totalHigh: 1,
  totalModerate: 1,
  projects: [
    {
      key: "vibeflow",
      name: "Vibeflow",
      summary: "AI coding orchestrator project",
      high: [
        {
          title: "New Agent Framework (FlowKit)",
          url: "https://example.com/flowkit",
          summary: "FlowKit improves subagent orchestration for complex workflows.",
          reason: "Improves Vibeflow orchestration efficiency.",
          usefulness: "HIGH",
          publishedAt: "2025-09-20",
          sourceType: "YouTube"
        }
      ],
      moderate: [
        {
          title: "Token Optimization Tips",
          url: "https://example.com/token-tips",
          summary: "Blog with tips on reducing token usage to avoid exceeding free quotas.",
          reason: "Helps reduce runtime costs for Vibeflow.",
          usefulness: "MODERATE",
          publishedAt: "2025-09-21",
          sourceType: "Blog"
        }
      ],
      changelog: []
    }
  ]
};

const htmlContent = renderHtmlDigest(payload);
const textContent = "Mock digest preview\n\nSee your inbox for HTML.";

const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);

sendBrevoEmail({
  subject: payload.subject,
  textContent,
  htmlContent,
  recipients
}).catch((err) => {
  console.error("Failed to send mock digest", err);
  process.exitCode = 1;
});
