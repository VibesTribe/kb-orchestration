import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, saveJsonCheckpoint } from "./lib/utils.js";
import { digest } from "./digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");

const mockCurated = {
  generatedAt: new Date().toISOString(),
  items: [
    {
      canonicalId: "item-flowkit",
      title: "New Agent Framework (FlowKit)",
      url: "https://original-resource.com/flowkit-release",
      summary: "FlowKit framework improves subagent orchestration for complex workflows.",
      description: "",
      publishedAt: new Date().toISOString(),
      sourceType: "youtube",
      projects: [
        {
          project: "Vibeflow",
          projectKey: "vibeflow",
          usefulness: "HIGH",
          reason: "Improves Vibeflow build-phase orchestration efficiency without adding overhead.",
          nextSteps: "Evaluate integration with existing orchestrator."
        }
      ],
      assignedProjects: ["Vibeflow"]
    },
    {
      canonicalId: "item-token-blog",
      title: "Blog on token optimization",
      url: "https://original-resource.com/token-blog",
      summary: "Tips on reducing token usage to avoid exceeding free tier quotas.",
      description: "",
      publishedAt: new Date().toISOString(),
      sourceType: "rss",
      projects: [
        {
          project: "Vibeflow",
          projectKey: "vibeflow",
          usefulness: "MODERATE",
          reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents.",
          nextSteps: "Adopt best practices for prompt design."
        }
      ],
      assignedProjects: ["Vibeflow"]
    },
    {
      canonicalId: "item-tree-visualizer",
      title: "New Family Tree Visualization Tool",
      url: "https://original-resource.com/tree-visualization",
      summary: "Interactive visualization for genealogical data with collapsible branches.",
      description: "",
      publishedAt: new Date().toISOString(),
      sourceType: "github",
      projects: [
        {
          project: "Webs of Wisdom",
          projectKey: "websofwisdom",
          usefulness: "HIGH",
          reason: "Could be integrated into Webs of Wisdom for better user navigation.",
          nextSteps: "Prototype with sample genealogical data."
        }
      ],
      assignedProjects: ["Webs of Wisdom"]
    }
  ]
};

async function main() {
  const dayDir = new Date().toISOString().slice(0, 10);
  const stampDir = "mock-run";
  const curatedDir = path.join(CURATED_ROOT, dayDir, stampDir);
  await ensureDir(curatedDir);

  const itemsPath = path.join(curatedDir, "items.json");
  await saveJsonCheckpoint(itemsPath, mockCurated);

  console.log("Mock curated data saved", { itemsPath });

  // Now run the normal digest logic, which will send the email
  await digest();
}

main().catch((err) => {
  console.error("Mock digest failed", err);
  process.exit(1);
});
