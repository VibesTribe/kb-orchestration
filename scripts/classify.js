import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
function classifyItemAgainstProject(item, project) {
  const text = [
    item.title ?? "",
    item.summary ?? "",
    item.description ?? "",
    (item.tags ?? []).join(" "),
  ].join("\n");

  const context = [
    project.summary ?? "",
    (project.objectives ?? []).join("\n"),
    (project.techStack ?? []).join("\n"),
    project.prd ?? "",
    project.changelog ?? "",
  ].join("\n");

  let usefulness = "archive";
  let reason = "Does not appear directly relevant.";
  let nextSteps = null;

  const highCriteria = (project.usefulnessCriteria?.high ?? []);
  const moderateCriteria = (project.usefulnessCriteria?.moderate ?? []);

  if (highCriteria.some((c) => text.toLowerCase().includes(c.toLowerCase()))) {
    usefulness = "high";
    reason = "Matches high usefulness criteria.";
    nextSteps = "Evaluate for direct integration or adoption.";
  } else if (moderateCriteria.some((c) => text.toLowerCase().includes(c.toLowerCase()))) {
    usefulness = "moderate";
    reason = "Matches moderate usefulness criteria.";
    nextSteps = "Monitor for near-term adaptation.";
  }

  return {
    project: project.name ?? project.key,
    usefulness,
    reason,
    nextSteps,
  };
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
    if (state.completedItems.includes(item.id)) {
      continue; // already classified
    }

    const assignments = [];
    for (const project of projects) {
      const classification = classifyItemAgainstProject(item, project);
      assignments.push(classification);
    }

    item.assignedProjects = assignments;

    state.completedItems.push(item.id);
    await saveState(state);
  }

  await saveJson(curatedRun.itemsPath, curatedRun.content);
  log("Classification complete", { itemCount: items.length });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((err) => {
    console.error("Classify step failed", err);
    process.exitCode = 1;
  });
}
