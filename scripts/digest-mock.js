import { ensureDir, saveJsonCheckpoint } from "./lib/utils.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

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
          reason: "Helps lower Vibeflow runtime costs when scaling tasks with multiple agents
