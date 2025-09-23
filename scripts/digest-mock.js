import { ensureDir, saveJsonCheckpoint } from "./lib/utils.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");

const mockDigest = {
  generatedAt: new Date().toISOString(),
  subject: "Daily Digest – 2 Highly Useful + 1 Moderately Useful",
  totalHigh: 2,
  totalModerate: 1,
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
          usefulness: "HIGH",
          reason: "Improves Vibeflow build-phase orchestration efficiency without adding overhead.",
          nextSteps: "Evaluate integration with existing orchestrator.",
          publishedAt: new Date().toISOString(),
          sourceType: "youtube"
        }
      ],
      moderate: [
        {
          title: "Blog on token optimization",
          url: "https://original-resource.com/token-blog",
          summary: "Tips on reducing token usage to avoid exceeding free tier quotas.",
          usefulness: "MODERATE",
          reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents.",
          nextSteps: "Adopt best practices for prompt design.",
          publishedAt: new Date().toISOString(),
          sourceType: "rss"
        }
      ],
      changelog: [
        "- 2025-09-20: Imported PRD v2.0 and initial project metadata into kb-orchestration.",
        "- 2025-09-21: Added token usage tracking system.",
        "- 2025-09-22: Integrated FlowKit framework for agent orchestration."
      ]
    },
    {
      key: "websofwisdom",
      name: "Webs of Wisdom",
      summary: "Storytelling and genealogy platform that weaves family histories with interactive multimedia.",
      high: [
        {
          title: "New Family Tree Visualization Tool",
          url: "https://original-resource.com/tree-visualization",
          summary: "Interactive visualization for genealogical data with collapsible branches.",
          usefulness: "HIGH",
          reason: "Could be integrated into Webs of Wisdom for better user navigation.",
          nextSteps: "Prototype with sample genealogical data.",
          publishedAt: new Date().toISOString(),
          sourceType: "github"
        }
      ],
      moderate: [],
      changelog: [
        "- 2025-09-19: Added multimedia attachment support for stories.",
        "- 2025-09-21: Improved search for genealogical data sources."
      ]
    }
  ]
};

async function main() {
  const digestDir = path.join(
    DIGEST_ROOT,
    new Date().toISOString().slice(0, 10),
    "mock-run"
  );
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  await saveJsonCheckpoint(jsonPath, mockDigest);

  console.log("Mock digest saved", { jsonPath });
}

main().catch((err) => {
  console.error("Mock digest failed", err);
  process.exit(1);
});
