// scripts/digest-mock.js
import { digest } from "./digest.js";
import { saveJsonCheckpoint, saveTextCheckpoint, ensureDir } from "../lib/utils.js";
import path from "node:path";
import fs from "node:fs/promises";

const ROOT_DIR = path.resolve(".");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest", "mock");

async function runMockDigest() {
  const mockData = {
    generatedAt: new Date().toISOString(),
    subject: "Knowledgebase Digest – 2 Highly Useful + 2 Moderately Useful",
    totalHigh: 2,
    totalModerate: 2,
    projects: [
      {
        key: "vibeflow",
        name: "Vibeflow",
        summary:
          "Human-in-the-loop AI orchestration system that keeps non-technical users in strategic control while automating modular agent workflows.",
        high: [
          {
            title: "New Agent Framework (FlowKit)",
            url: "https://original-resource.com/flowkit-release",
            summary: "FlowKit framework improves subagent orchestration for complex workflows.",
            usefulness: "HIGHLY USEFUL",
            reason: "Improves Vibeflow build-phase orchestration efficiency without adding overhead.",
            nextSteps: "Evaluate integration with existing orchestrator.",
            publishedAt: "September 23, 2025",
            sourceType: "youtube",
          },
        ],
        moderate: [
          {
            title: "Blog on token optimization",
            url: "https://original-resource.com/token-blog",
            summary: "Tips on reducing token usage to avoid exceeding free tier quotas.",
            usefulness: "MODERATELY USEFUL",
            reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents.",
            nextSteps: "Adopt best practices for prompt design.",
            publishedAt: "September 23, 2025",
            sourceType: "rss",
          },
        ],
        changelog: [
          "- 2025-09-20: Imported PRD v2.0 and initial project metadata into kb-orchestration.",
          "- 2025-09-21: Added token usage tracking system.",
          "- 2025-09-22: Integrated FlowKit framework for agent orchestration.",
        ],
      },
      {
        key: "webs-of-wisdom",
        name: "Webs of Wisdom",
        summary: "Storytelling and genealogy platform that weaves family histories with interactive multimedia.",
        high: [
          {
            title: "New Family Tree Visualization Tool",
            url: "https://original-resource.com/tree-visualization",
            summary: "Interactive visualization for genealogical data with collapsible branches.",
            usefulness: "HIGHLY USEFUL",
            reason: "Could be integrated into Webs of Wisdom for better user navigation.",
            nextSteps: "Prototype with sample genealogical data.",
            publishedAt: "September 23, 2025",
            sourceType: "github",
          },
        ],
        moderate: [
          {
            title: "Article on interactive storytelling",
            url: "https://original-resource.com/storytelling-article",
            summary: "Overview of new techniques in AI-driven narrative building.",
            usefulness: "MODERATELY USEFUL",
            reason: "Offers inspiration for enhancing storytelling modules.",
            nextSteps: "Test feasibility in story builder module.",
            publishedAt: "September 23, 2025",
            sourceType: "blog",
          },
        ],
        changelog: [
          "- 2025-09-19: Added multimedia attachment support for stories.",
          "- 2025-09-21: Improved search for genealogical data sources.",
        ],
      },
    ],
  };

  const digestDir = path.join(DIGEST_ROOT, "latest");
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");

  await saveJsonCheckpoint(jsonPath, mockData);
  await saveTextCheckpoint(textPath, JSON.stringify(mockData, null, 2));

  console.log("✅ Mock digest artifacts written", { jsonPath, textPath });

  // Call digest to send email with mock data
  await digest();
}

runMockDigest().catch((err) => {
  console.error("Mock digest failed", err);
  process.exitCode = 1;
});
