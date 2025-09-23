import { digest } from "./digest.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");

// Mock curated data
const curatedRun = {
  dayDir: "2025-09-23",
  stampDir: "05-01-00",
  content: {
    items: [
      {
        title: "New Agent Framework (FlowKit)",
        url: "https://original-resource.com/flowkit-release",
        summary: "FlowKit framework improves subagent orchestration for complex workflows.",
        publishedAt: new Date().toISOString(),
        sourceType: "youtube",
        projects: [{ projectKey: "vibeflow", usefulness: "HIGH", reason: "Improves Vibeflow build-phase orchestration efficiency without adding overhead.", nextSteps: "Evaluate integration with existing orchestrator." }]
      },
      {
        title: "Blog on token optimization",
        url: "https://original-resource.com/token-blog",
        summary: "Tips on reducing token usage to avoid exceeding free tier quotas.",
        publishedAt: new Date().toISOString(),
        sourceType: "rss",
        projects: [{ projectKey: "vibeflow", usefulness: "MODERATE", reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents.", nextSteps: "Adopt best practices for prompt design." }]
      },
      {
        title: "New Family Tree Visualization Tool",
        url: "https://original-resource.com/tree-visualization",
        summary: "Interactive visualization for genealogical data with collapsible branches.",
        publishedAt: new Date().toISOString(),
        sourceType: "youtube",
        projects: [{ projectKey: "webs-of-wisdom", usefulness: "HIGH", reason: "Could be integrated into Webs of Wisdom for better user navigation.", nextSteps: "Prototype with sample genealogical data." }]
      },
      {
        title: "Article on interactive storytelling",
        url: "https://original-resource.com/storytelling-article",
        summary: "Overview of new techniques in AI-driven narrative building.",
        publishedAt: new Date().toISOString(),
        sourceType: "rss",
        projects: [{ projectKey: "webs-of-wisdom", usefulness: "MODERATE", reason: "Offers inspiration for enhancing storytelling modules.", nextSteps: "Review methods for next design sprint." }]
      }
    ]
  }
};

// Mock projects metadata
async function writeMockProjects() {
  const projectsDir = path.join(ROOT_DIR, "projects");
  await ensureDir(projectsDir);

  const vibeflowDir = path.join(projectsDir, "vibeflow");
  await ensureDir(vibeflowDir);
  await fs.writeFile(
    path.join(vibeflowDir, "project.json"),
    JSON.stringify(
      {
        key: "vibeflow",
        name: "Vibeflow",
        summary:
          "Human-in-the-loop AI orchestration system that keeps non-technical users in strategic control while automating modular agent workflows.",
        changelog: [
          "- 2025-09-20: Imported PRD v2.0 and initial project metadata into kb-orchestration.",
          "- 2025-09-21: Added token usage tracking system.",
          "- 2025-09-22: Integrated FlowKit framework for agent orchestration."
        ]
      },
      null,
      2
    )
  );

  const websDir = path.join(projectsDir, "webs-of-wisdom");
  await ensureDir(websDir);
  await fs.writeFile(
    path.join(websDir, "project.json"),
    JSON.stringify(
      {
        key: "webs-of-wisdom",
        name: "Webs of Wisdom",
        summary:
          "Storytelling and genealogy platform that weaves family histories with interactive multimedia.",
        changelog: [
          "- 2025-09-19: Added multimedia attachment support for stories.",
          "- 2025-09-21: Improved search for genealogical data sources."
        ]
      },
      null,
      2
    )
  );
}

async function main() {
  // Ensure digest dir
  const digestDir = path.join(DIGEST_ROOT, curatedRun.dayDir, curatedRun.stampDir);
  await ensureDir(digestDir);

  // Write mock curated items
  await fs.writeFile(
    path.join(digestDir, "items.json"),
    JSON.stringify(curatedRun.content, null, 2)
  );

  // Write mock projects
  await writeMockProjects();

  // Run digest pipeline
  await digest();
}

main().catch((err) => {
  console.error("Mock digest run failed", err);
  process.exit(1);
});
