import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { callOpenRouter } from "./lib/openrouter.js";
import { saveJsonCheckpoint, ensureDir, loadJson, listDirectories } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ENRICHED_ROOT = path.join(ROOT_DIR, "data", "enriched");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const CLASSIFICATION_CACHE_PATH = path.join(CACHE_ROOT, "classification.json");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

export async function classify() {
  const enrichedRun = await getLatestRun(ENRICHED_ROOT);
  if (!enrichedRun) {
    log("No enriched data found; skip classification");
    return;
  }

  const projects = await loadProjects();
  const activeProjects = projects.filter((project) => project.status === "active");
  if (!activeProjects.length) {
    log("No active projects; skip classification");
    return;
  }

  const classificationCache = await loadJson(CLASSIFICATION_CACHE_PATH, {});
  const curatedRunDir = path.join(CURATED_ROOT, enrichedRun.dayDir, enrichedRun.stampDir);
  await ensureDir(curatedRunDir);
  await ensureDir(CACHE_ROOT);

  const outputPath = path.join(curatedRunDir, "items.json");
  const existingOutput = await loadJson(outputPath, null);
  const curatedItems = existingOutput?.items ?? [];

  const processedIds = new Set(curatedItems.map((i) => i.canonicalId));

  for (const item of enrichedRun.content.items ?? []) {
    if (processedIds.has(item.canonicalId)) continue;

    const assessments = [];
    for (const project of activeProjects) {
      const assessment = await classifyForProject(item, project, classificationCache);
      if (assessment) assessments.push(assessment);
    }

    curatedItems.push({
      ...item,
      projects: assessments,
      assignedProjects: assessments
        .filter((entry) => entry.usefulness !== "ARCHIVE")
        .map((entry) => entry.project)
    });

    const checkpointOutput = {
      generatedAt: new Date().toISOString(),
      inputItems: path.relative(ROOT_DIR, enrichedRun.itemsPath),
      projectCount: activeProjects.length,
      itemCount: curatedItems.length,
      items: curatedItems
    };

    // Save checkpoint after each item
    await saveJsonCheckpoint(outputPath, checkpointOutput);
    await saveJsonCheckpoint(CLASSIFICATION_CACHE_PATH, classificationCache);

    log("Checkpoint saved", {
      item: item.title,
      classifiedSoFar: curatedItems.length
    });
  }

  log("Classification complete", {
    itemsPath: path.relative(ROOT_DIR, outputPath),
    classifiedItems: curatedItems.length
  });
}

async function classifyForProject(item, project, cache) {
  const projectKey = project.key;
  cache[projectKey] ??= {};

  const canonicalId = item.canonicalId ?? hash(JSON.stringify(item));
  const cacheKey = `${projectKey}:${canonicalId}`;
  const itemHash = hash(`${item.summary ?? ""}|${item.description ?? ""}|${item.title ?? ""}`);

  const cached = cache[projectKey][canonicalId];
  if (cached && cached.itemHash === itemHash) {
    return cached.result;
  }

  let result;
  if (OPENROUTER_API_KEY) {
    result = await classifyWithModel(item, project);
  } else {
    result = fallbackClassification(item, project);
  }

  cache[projectKey][canonicalId] = {
    itemHash,
    result
  };

  return result;
}

async function classifyWithModel(item, project) {
  const prompt = buildClassificationPrompt(item, project);
  try {
    const { content, model } = await callOpenRouter(
      [
        {
          role: "system",
          content:
            "You classify research signals for the Vibeflow knowledgebase. Respond in JSON with usefulness (HIGH, MODERATE, ARCHIVE), reason, and optional next_steps."
        },
        { role: "user", content: prompt }
      ],
      { maxTokens: 220, temperature: 0.1 }
    );
    log("Classified item", { model, title: item.title, project: project.name });
    const parsed = parseModelJson(content);
    return normalizeAssessment(parsed, project, item);
  } catch (error) {
    log("OpenRouter classification failed", { error: error.message, title: item.title, project: project.name });
    return fallbackClassification(item, project);
  }
}

function fallbackClassification(item, project) {
  const haystack = `${item.title ?? ""} ${item.summary ?? ""} ${item.description ?? ""}`.toLowerCase();
  const techHit = project.techStack.some((tech) => haystack.includes(tech.toLowerCase()));
  const objectiveHit = project.objectives.some((obj) => haystack.includes(obj.toLowerCase()));

  let usefulness = "ARCHIVE";
  if (techHit && objectiveHit) usefulness = "HIGH";
  else if (techHit || objectiveHit) usefulness = "MODERATE";

  return {
    project: project.name,
    projectKey: project.key,
    usefulness,
    reason:
      usefulness === "ARCHIVE"
        ? "Heuristic fallback: no strong match to objectives/tech stack"
        : "Heuristic fallback based on keyword overlap",
    nextSteps: ""
  };
}

function buildClassificationPrompt(item, project) {
  const parts = [];
  parts.push(`Project Name: ${project.name}`);
  parts.push(`Project Summary: ${project.summary}`);
  parts.push(`Status: ${project.status}`);
  if (project.objectives?.length) parts.push(`Objectives: ${project.objectives.join("; ")}`);
  if (project.techStack?.length) parts.push(`Tech Stack: ${project.techStack.join(", ")}`);
  if (project.usefulnessCriteria) {
    parts.push(`High usefulness if: ${project.usefulnessCriteria.high?.join("; ") ?? ""}`);
    parts.push(`Moderate usefulness if: ${project.usefulnessCriteria.moderate?.join("; ") ?? ""}`);
    parts.push(`Archive if: ${project.usefulnessCriteria.archive?.join("; ") ?? ""}`);
  }
  if (project.context) parts.push(`PRD Context: ${project.context}`);
  parts.push("---");
  parts.push(`Item Title: ${item.title ?? "(untitled)"}`);
  if (item.url) parts.push(`Item URL: ${item.url}`);
  if (item.summary) parts.push(`Summary: ${item.summary}`);
  if (item.description) parts.push(`Description: ${item.description}`);
  if (item.tags?.length) parts.push(`Tags: ${item.tags.join(", ")}`);
  if (item.publishedAt) parts.push(`Published At: ${item.publishedAt}`);
  parts.push("Return JSON with usefulness (HIGH|MODERATE|ARCHIVE), reason, next_steps (optional).");
  return parts.join("\n");
}

function parseModelJson(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAssessment(parsed, project, item) {
  const defaultAssessment = fallbackClassification(item, project);
  if (!parsed) return defaultAssessment;

  const usefulness = String(parsed.usefulness ?? parsed.rating ?? "").toUpperCase();
  if (!["HIGH", "MODERATE", "ARCHIVE"].includes(usefulness)) return defaultAssessment;

  return {
    project: project.name,
    projectKey: project.key,
    usefulness,
    reason: parsed.reason ?? "Model provided no reason",
    nextSteps: parsed.next_steps ?? parsed.nextSteps ?? ""
  };
}

async function loadProjects() {
  const entries = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of entries) {
    const projectDir = path.join(PROJECTS_ROOT, dir);
    const configPath = path.join(projectDir, "project.json");
    const prdPath = path.join(projectDir, "prd.md");
    const config = await loadJson(configPath, null);
    if (!config) continue;
    const prdText = await fs.readFile(prdPath, "utf8").catch(() => "");
    projects.push({ key: dir, context: prdText.slice(0, 4000), ...config });
  }
  return projects;
}

async function getLatestRun(root) {
  const dayDirs = await listDirectories(root);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();
  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(root, dayDir));
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(root, dayDir, stampDir, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content) return { dayDir, stampDir, itemsPath, content };
    }
  }
  return null;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((error) => {
    console.error("Classification step failed", error);
    process.exitCode = 1;
  });
}
