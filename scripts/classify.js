import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./openrouter.js";

/* ------------------ Utilities ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
async function loadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function saveJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
async function loadText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
function log(message, context = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${ts}] ${message}${payload}`);
}

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "classify-state.json");

/* ------------------ State helpers ------------------ */
async function loadState() {
  return (await loadJson(STATE_FILE, { completedItems: [] }));
}
async function saveState(state) {
  await saveJson(STATE_FILE, state);
}

/* ------------------ Project loader ------------------ */
async function loadProjects() {
  const projects = [];
  const projectDirs = await listDirectories(PROJECTS_ROOT);

  for (const dir of projectDirs) {
    const projectJson = await loadJson(path.join(PROJECTS_ROOT, dir, "project.json"), null);
    if (!projectJson) continue;
    if (projectJson.status && projectJson.status.toLowerCase() !== "active") continue;

    const prdText = await loadText(path.join(PROJECTS_ROOT, dir, "prd.md"));
    const changelogText = await loadText(path.join(PROJECTS_ROOT, dir, "changelog.md"));

    projects.push({
      key: dir,
      ...projectJson,
      prd: prdText,
      changelog: changelogText,
    });
  }
  return projects;
}

/* ------------------ Curated loader ------------------ */
async function getLatestCuratedRun() {
  const dayDirs = await listDirectories(CURATED_ROOT);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();

  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(CURATED_ROOT, dayDir));
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(CURATED_ROOT, dayDir, stampDir, "items.json");
      const items = await loadJson(itemsPath, null);
      if (items) {
        return { dayDir, stampDir, itemsPath, content: items };
      }
    }
  }
  return null;
}

/* ------------------ Classification logic ------------------ */
async function classifyItemAgainstProject(item, project) {
  const systemPrompt = `
You are a precise classification agent. 
Classify the following item for the project "${project.name}".
Return JSON with keys: usefulness (HIGH|MODERATE|ARCHIVE), reason, nextSteps.
Be strict and consistent. Use the PRD and usefulness criteria provided.
`;

  const userPrompt = `
Project Summary:
${project.summary}

Objectives:
${(project.objectives ?? []).join("\n")}

Tech Stack:
${(project.techStack ?? []).join(", ")}

Usefulness Criteria:
High: ${(project.usefulnessCriteria?.high ?? []).join(" | ")}
Moderate: ${(project.usefulnessCriteria?.moderate ?? []).join(" | ")}
Archive: ${(project.usefulnessCriteria?.archive ?? []).join(" | ")}

Prompt Hint:
${project.promptHints?.classification ?? ""}

PRD:
${project.prd?.slice(0, 4000) ?? ""}

Changelog (recent lines):
${project.changelog?.slice(0, 20).join("\n") ?? ""}

---
Item to classify:
Title: ${item.title}
Summary: ${item.summary ?? ""}
Description: ${item.description ?? ""}
Tags: ${(item.tags ?? []).join(", ")}
URL: ${item.url ?? ""}
`;

  const { content } = await callOpenRouter(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 300 }
  );

  try {
    const parsed = JSON.parse(content);
    return {
      project: project.name ?? project.key,
      projectKey: project.key,
      usefulness: parsed.usefulness?.toUpperCase() ?? "ARCHIVE",
      reason: parsed.reason ?? "No reason given",
      nextSteps: parsed.nextSteps ?? "",
    };
  } catch {
    // fallback if LLM didn’t return JSON
    return {
      project: project.name ?? project.key,
      projectKey: project.key,
      usefulness: "ARCHIVE",
      reason: "LLM response parse failed",
      nextSteps: "",
    };
  }
}

/* ------------------ Main classify step ------------------ */
export async function classify() {
  const curatedRun = await getLatestCuratedRun();
  if (!curatedRun) {
    log("No curated run found; skip classify");
    return;
  }

  const projects = await loadProjects();
  if (!projects.length) {
    log("No active projects found; skip classify");
    return;
  }

  const state = await loadState();
  const items = curatedRun.content.items ?? [];

  for (const item of items) {
    if (state.completedItems.includes(item.id)) continue; // already classified

    const assignments = [];
    for (const project of projects) {
      const classification = await classifyItemAgainstProject(item, project);
      assignments.push(classification);
    }

    item.projects = assignments; // keep consistent with digest.js
    state.completedItems.push(item.id);

    // Save incrementally
    await saveJson(curatedRun.itemsPath, curatedRun.content);
    await saveState(state);

    log("Classified item", { id: item.id, title: item.title });
  }

  log("Classification complete", { itemCount: items.length });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify step failed", err);
    process.exitCode = 1;
  });
}
