import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  log,
  ensureDir,
  loadJson,
  saveJson,
  listDirectories,
  hash,
  truncate,
} from "./lib/utils.js";
import { callOpenRouter } from "./lib/openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ENRICHED_ROOT = path.join(ROOT_DIR, "data", "enriched");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const CLASSIFICATION_CACHE_PATH = path.join(CACHE_ROOT, "classification.json");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

export async function classify() {
  const enrichedRun = await getLatestRun(ENRICHED_ROOT);
  if (!enrichedRun) {
    log("No enriched run found; skip classification");
    return;
  }

  const projects = await loadProjects();
  const activeProjects = projects.filter((p) => p.status === "active");
  if (!activeProjects.length) {
    log("No active projects; skip");
    return;
  }

  const classificationCache = await loadJson(CLASSIFICATION_CACHE_PATH, {});
  const curatedRunDir = path.join(CURATED_ROOT, enrichedRun.dayDir, enrichedRun.stampDir);
  await ensureDir(curatedRunDir);
  await ensureDir(CACHE_ROOT);

  const outputPath = path.join(curatedRunDir, "items.json");
  const itemsSoFar = await loadJson(outputPath, { items: [] });

  for (const item of enrichedRun.content.items ?? []) {
    const assessments = [];
    for (const project of activeProjects) {
      try {
        const assessment = await classifyForProject(item, project, classificationCache);
        if (assessment) assessments.push(assessment);

        // ✅ Save cache after each project classification
        await saveJson(CLASSIFICATION_CACHE_PATH, classificationCache);
      } catch (err) {
        log("Classification error", { err: err.message, title: item.title });
        continue;
      }
    }

    const curatedItem = {
      ...item,
      projects: assessments,
      assignedProjects: assessments
        .filter((a) => a.usefulness !== "ARCHIVE")
        .map((a) => a.project),
    };

    itemsSoFar.items.push(curatedItem);

    // ✅ Save progress after each item
    await saveJson(outputPath, itemsSoFar);
  }

  log("Classification complete", { count: itemsSoFar.items.length });
}

async function classifyForProject(item, project, cache) {
  const projectKey = project.key;
  cache[projectKey] ??= {};

  const canonicalId = item.canonicalId ?? hash(JSON.stringify(item));
  const cacheKey = `${projectKey}:${canonicalId}`;

  if (cache[projectKey][canonicalId]) {
    return cache[projectKey][canonicalId].result;
  }

  let result;
  if (OPENROUTER_API_KEY) {
    result = await classifyWithModel(item, project);
  } else {
    result = fallbackClassification(item, project);
  }

  cache[projectKey][canonicalId] = { result };
  return result;
}

async function classifyWithModel(item, project) {
  const prompt = `Classify this item for project ${project.name}:\n${item.title}\n${item.summary ?? item.description}`;
  const { content } = await callOpenRouter(
    [
      { role: "system", content: "Classify usefulness (HIGH, MODERATE, ARCHIVE) in JSON." },
      { role: "user", content: prompt },
    ],
    { maxTokens: 220, temperature: 0.1 }
  );

  try {
    return JSON.parse(content);
  } catch {
    return fallbackClassification(item, project);
  }
}

function fallbackClassification(item, project) {
  const text = `${item.title} ${item.summary} ${item.description}`.toLowerCase();
  const techHit = project.techStack?.some((t) => text.includes(t.toLowerCase()));
  const objHit = project.objectives?.some((o) => text.includes(o.toLowerCase()));
  let usefulness = "ARCHIVE";
  if (techHit && objHit) usefulness = "HIGH";
  else if (techHit || objHit) usefulness = "MODERATE";

  return { project: project.name, usefulness, reason: "Fallback keyword match" };
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

async function loadProjects() {
  const dirs = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of dirs) {
    const config = await loadJson(path.join(PROJECTS_ROOT, dir, "project.json"), null);
    if (!config) continue;
    projects.push({ key: dir, ...config });
  }
  return projects;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classification failed", err);
    process.exitCode = 1;
  });
}
