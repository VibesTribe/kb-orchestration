import { digest } from "./digest.js";
import { ensureDir } from "./lib/utils.js";
import path from "node:path";
import fs from "node:fs/promises";

const ROOT_DIR = path.resolve(".");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");

// Minimal mock curated data
const mockCurated = {
  generatedAt: new Date().toISOString(),
  items: [
    {
      id: "flowkit-123",
      title: "New Agent Framework (FlowKit)",
      url: "https://original-resource.com/flowkit-release",
      summary: "FlowKit framework improves subagent orchestration for complex workflows.",
      description: "",
      publishedAt: new Date().toISOString(),
      sourceType: "youtube",
      projects: [
        {
          projectKey: "vibeflow",
          project: "Vibeflow",
          usefulness: "HIGH",
          reason: "Improves Vibeflow build-phase orchestration efficiency without adding overhead.",
          nextSteps: "Evaluate integration with existing orchestrator."
        }
      ]
    },
    {
      id: "token-blog-456",
      title: "Blog on token optimization",
      url: "https://original-resource.com/token-blog",
      summary: "Tips on reducing token usage to avoid exceeding free tier quotas.",
      description: "",
      publishedAt: new Date().toISOString(),
      sourceType: "rss",
      projects: [
        {
          projectKey: "vibeflow",
          project: "Vibeflow",
          usefulness: "MODERATE",
          reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents.",
          nextSteps: "Adopt best practices for prompt design."
        }
      ]
    }
  ]
};

async function setupMock() {
  const dayDir = new Date().toISOString().slice(0, 10);
  const stampDir = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(CURATED_ROOT, dayDir, stampDir);
  await ensureDir(runDir);

  const itemsPath = path.join(runDir, "items.json");
  await fs.writeFile(itemsPath, JSON.stringify(mockCurated, null, 2), "utf8");
  console.log("Mock curated data written to", itemsPath);
}

setupMock()
  .then(() => digest())
  .catch((err) => {
    console.error("Mock digest failed", err);
    process.exit(1);
  });
