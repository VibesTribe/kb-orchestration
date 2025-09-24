// scripts/classify.js
// Classify latest curated run items against active projects.
// Writes assignments back into the curated run's items and records progress in data/cache/classify-state.json

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const STATE_FILE = path.join(ROOT_DIR, "data", "cache", "classify-state.json");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${payload}`);
}

async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function loadProjects() {
  const projects = [];
  const dirs = await listDirectories(PROJECTS_ROOT);
  for (const dir of dirs) {
    const pth = path.join(PROJECTS_ROOT, dir, "project.json");
    const config = await loadJson(pth, null);
    if (!config) continue;
    // Respect explicit status; treat missing status as active
    const status = (config.status ?? "active").toLowerCase();
    if (status !== "active") continue;
    const prd = await fs.readFile(path.join(PROJECTS_ROOT, dir, "prd.md"), "utf8").catch(() => "");
    const changelog = await fs.readFile(path.join(PROJECTS_ROOT, dir, "changelog.md"), "utf8").catch(() => "");
    projects.push({
      key: dir,
      prd,
      changelog,
      ...config
    });
  }
  return projects;
}

async function getLatestCuratedRun() {
  // Find latest day/stamp with items.json
  const dayDirs = await listDirectories(CURATED_ROOT);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();
  for (const day of dayDirs) {
    const stamps = await listDirectories(path.join(CURATED_ROOT, day));
    stamps.sort().reverse();
    for (const stamp of stamps) {
      const itemsPath = path.join(CURATED_ROOT, day, stamp, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content && Array.isArray(content.items)) {
        return { dayDir: day, stampDir: stamp, itemsPath, content };
      }
    }
  }
  return null;
}

function normalizeTextForMatching(item) {
  return [
    item.title ?? "",
    item.summary ?? "",
    item.description ?? "",
    ...(item.tags ?? []).join(" ")
  ].join("\n").toLowerCase();
}

function classifyItemAgainstProject(item, project) {
  // Use project's usefulnessCriteria arrays (high / moderate) to check matches.
  // Case-insensitive substring match on the criteria text.
  const text = normalizeTextForMatching(item);
  let usefulness = "archive";
  let reason = "Does not appear directly relevant.";
  let nextSteps = "";

  const highCriteria = project.usefulnessCriteria?.high ?? [];
  const moderateCriteria = project.usefulnessCriteria?.moderate ?? [];

  if (highCriteria.some(c => c && text.includes(c.toLowerCase()))) {
    usefulness = "HIGH";
    reason = "Matches high usefulness criteria.";
    nextSteps = "Evaluate for direct integration or adoption.";
  } else if (moderateCriteria.some(c => c && text.includes(c.toLowerCase()))) {
    usefulness = "MODERATE";
    reason = "Matches moderate usefulness criteria.";
    nextSteps = "Monitor for near-term adaptation.";
  }

  return {
    project: project.name ?? project.key,
    projectKey: project.key,
    usefulness,
    reason,
    nextSteps
  };
}

export async function classify() {
  const curated = await getLatestCuratedRun();
  if (!curated) {
    log("No curated run found; skipping classify");
    return;
  }

  const projects = await loadProjects();
  if (!projects.length) {
    log("No active projects found; skipping classify");
    return;
  }

  const state = await loadJson(STATE_FILE, { completedItems: [] });

  let changed = false;
  for (const item of curated.content.items ?? []) {
    // normalize id
    const id = item.id ?? item.canonicalId ?? item.url;
    if (!id) continue;
    if (state.completedItems.includes(id)) continue;

    const assignments = [];
    for (const project of projects) {
      const classification = classifyItemAgainstProject(item, project);
      // Only push if useful or if we want to keep archives too (we store all)
      assignments.push(classification);
    }

    // Save assignedProjects as the array of classification results
    item.projects = assignments;
    item.assignedProjects = assignments.map(a => a.projectKey);

    state.completedItems.push(id);
    changed = true;
    // Save progress incrementally
    await saveJson(curated.itemsPath, curated.content);
    await saveJson(STATE_FILE, state);
    log("Classified item", { id, title: item.title ?? "(untitled)" });
  }

  if (changed) {
    log("Classification complete", { items: curated.content.items.length });
  } else {
    log("No new items to classify");
  }
}

// Run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch(err => {
    console.error("Classify step failed", err);
    process.exitCode = 1;
  });
}
