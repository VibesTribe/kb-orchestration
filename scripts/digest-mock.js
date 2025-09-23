import { digest } from "./digest.js";
import { ensureDir } from "./lib/utils.js";
import path from "node:path";
import fs from "node:fs/promises";

const ROOT_DIR = path.resolve(".");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");

// Minimal mock curated data with changelog
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
    },
    {
      id: "tree-789",
      title: "New Family Tree Visualization Tool",
      url: "https://original-resource.com/tree-visualization",
      summary: "Interactive visualization for genealogical data with collapsible branches.",
      description: "",
      publishedAt: new Date().toISOString(),
      sourceType: "github",
      projects: [
        {
          projectKey: "webs-of-wisdom",
          project: "Webs of Wisdom",
          usefulness: "HIGH",
          reason: "Could be integrated into Webs of Wisdom for better user navigation.",
          nextSteps: "Prototype with sample genealogical data."
        }
      ]
    }
  ]
};

// Fake project changelogs
const mockProjects = [
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
  {
    key: "webs-of-wisdom",
    name: "Webs of Wisdom",
    summary:
      "Storytelling and genealogy platform that weaves family histories with interactive multimedia.",
    changelog: [
      "- 2025-09-19: Added multimedia attachment support for stories.",
      "- 2025-09-21: Improved search for genealogical data sources."
    ]
  }
];

async function setupMock() {
  const dayDir = new Date().toISOString().slice(0, 10);
  const stampDir = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(CURATED_ROOT, dayDir, stampDir);
  await ensureDir(runDir);

  // Save curated items
  await fs.writeFile(
    path.join(runDir, "items.json"),
    JSON.stringify(mockCurated, null, 2),
    "utf8"
  );

  // Save fake project configs with changelogs
  const projectsDir = path.join(ROOT_DIR, "projects");
  await ensureDir(projectsDir);

  for (const project of mockProjects) {
    const projectDir = path.join(projectsDir, project.key);
    await ensureDir(projectDir);

    await fs.writeFile(
      path.join(projectDir, "project.json"),
      JSON.stringify(
        { key: project.key, name: project.name, summary: project.summary },
        null,
        2
      ),
      "utf8"
    );

    await fs.writeFile(
      path.join(projectDir, "changelog.md"),
      project.changelog.join("\n"),
      "utf8"
    );
  }

  console.log("Mock curated data and project configs written.");
}

setupMock()
  .then(() => digest())
  .catch((err) => {
    console.error("Mock digest failed", err);
    process.exit(1);
  });
