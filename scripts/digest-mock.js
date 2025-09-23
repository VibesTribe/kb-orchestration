import { digest } from "./digest.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");

async function createMockCuratedRun() {
  const now = new Date();
  const dayDir = now.toISOString().slice(0, 10);
  const stampDir = now.toISOString().replace(/[:.]/g, "-");

  const mockDir = path.join(CURATED_ROOT, dayDir, stampDir);
  await ensureDir(mockDir);

  const items = [
    {
      id: "item-1",
      title: "New Agent Framework (FlowKit)",
      url: "https://original-resource.com/flowkit-release",
      summary: "FlowKit framework improves subagent orchestration for complex workflows.",
      description: "Longer description here if needed",
      publishedAt: now.toISOString(),
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
      description: "Detailed blog post about token savings.",
      publishedAt: now.toISOString(),
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
      description: "Full write-up of the visualization tool.",
      publishedAt: now.toISOString(),
      sourceType: "github",
      projects: [
        {
          project: "Webs of Wisdom",
          projectKey: "webs-of-wisdom",
          usefulness: "HIGH",
          reason: "Could be integrated into Webs of Wisdom for better user navigation.",
          nextSteps: "Prototype embedding tool into site."
        }
      ]
    },
    {
      id: "item-4",
      title: "Article on interactive storytelling",
      url: "https://original-resource.com/storytelling-article",
      summary: "Overview of new techniques in AI-driven narrative building.",
      description: "Some insights on storytelling.",
      publishedAt: now.toISOString(),
      sourceType: "rss",
      projects: [
        {
          project: "Webs of Wisdom",
          projectKey: "webs-of-wisdom",
          usefulness: "MODERATE",
          reason: "Offers inspiration for enhancing storytelling modules.",
