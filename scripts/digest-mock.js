import "dotenv/config";
import { digest } from "./digest.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");

// Build a fake curated run with two projects and some items
async function createMockCuratedRun() {
  const now = new Date().toISOString();
  const dayDir = now.slice(0, 10);
  const stampDir = now.replace(/[:.]/g, "-");

  const mockItems = [
    {
      id: "item-1",
      title: "New Agent Framework (FlowKit)",
      url: "https://original-resource.com/flowkit-release",
      summary: "FlowKit framework improves subagent orchestration for complex workflows.",
      description: "",
      publishedAt: now,
      sourceType: "youtube",
      projects: [
        {
          project: "Vibeflow",
          projectKey: "vibeflow",
          usefulness: "HIGH",
          reason: "Improves Vibeflow build-phase orchestration efficiency without adding overhead.",
          nextSteps: "Evaluate integration with existing orchestrator."
        }
      ]
    },
    {
      id: "item-2",
      title: "Blog on token optimization",
      url: "https://original-resource.com/token-blog",
      summary: "Tips on reducing token usage to avoid exceeding free tier quotas.",
      description: "",
      publishedAt: now,
      sourceType: "rss",
      projects: [
        {
          project: "Vibeflow",
          projectKey: "vibeflow",
          usefulness: "MODERATE",
          reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents.",
          nextSteps: "Adopt best practices for prompt design."
        }
      ]
    },
    {
      id: "item-3",
      title: "New Family Tree Visualization Tool",
      url: "https://original-resource.com/tree-visualization",
      summary: "Interactive visualization for genealogical data with collapsible branches.",
      description: "",
      publishedAt: now,
      sourceType: "github",
      projects: [
        {
          project: "Webs of Wisdom",
          projectKey: "webs-of-wisdom",
          usefulness: "HIGH",
          reason: "Could be integrated into Webs of Wisdom for better user navigation.",
          nextSteps: "Prototype with sample genealogical data."
        }
      ]
    }
  ];

  const curatedContent = {
    generatedAt: now,
    items: mockItems
  };

  const dayPath = path.join(CURATED_ROOT, dayDir);
  const stampPath = path.join(dayPath, stampDir);
  await fs.mkdir(stampPath, { recursive: true });
  await fs.writeFile(
    path.join(stampPath, "items.json"),
    JSON.stringify(curatedContent, null, 2),
    "utf8"
  );

  console.log("Mock curated run created", { dayDir, stampDir });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMockCuratedRun()
    .then(() => digest())
    .catch((err) => {
      console.error("Mock digest run failed", err);
      process.exitCode = 1;
    });
}
