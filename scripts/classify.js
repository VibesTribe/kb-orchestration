import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CURATED = path.join(DATA, "curated");
const CACHE = path.join(DATA, "cache");
const PROJECTS_ROOT = path.join(ROOT, "projects");
const STATE_FILE = path.join(CACHE, "classify-state.json");
const STATS_FILE = path.join(CACHE, "classify-stats.json");

function log(m, c={}){ console.log(`[${new Date().toISOString()}] ${m}`, Object.keys(c).length?c:""); }
async function ensureDir(p){ await fs.mkdir(p,{recursive:true}); }
async function loadJson(p, fb){ try { return JSON.parse(await fs.readFile(p,"utf8")); } catch { return fb; } }
async function saveJson(p, v){ await ensureDir(path.dirname(p)); await fs.writeFile(p, JSON.stringify(v,null,2), "utf8"); }
async function loadText(p){ try { return await fs.readFile(p,"utf8"); } catch { return ""; } }

async function latestCuratedRun() {
  const days = await fs.readdir(CURATED).catch(()=>[]);
  days.sort().reverse();
  for (const d of days) {
    const dPath = path.join(CURATED, d);
    const stamps = await fs.readdir(dPath).catch(()=>[]);
    stamps.sort().reverse();
    for (const s of stamps) {
      const f = path.join(dPath, s, "items.json");
      const json = await loadJson(f, null);
      if (json) return { path: f, content: json };
    }
  }
  return null;
}

async function loadProjects() {
  const dirs = await fs.readdir(PROJECTS_ROOT).catch(()=>[]);
  const projects = [];
  for (const dir of dirs) {
    const cfg = await loadJson(path.join(PROJECTS_ROOT, dir, "project.json"), null);
    if (!cfg) continue;
    if ((cfg.status||"active").toLowerCase() !== "active") continue;
    const prd = await loadText(path.join(PROJECTS_ROOT, dir, "prd.md"));
    const changelog = await loadText(path.join(PROJECTS_ROOT, dir, "changelog.md"));
    projects.push({ key: dir, ...cfg, prd, changelog });
  }
  return projects;
}

function classifyItem(item, project) {
  const text = `${item.title||""}\n${item.summary||""}\n${item.description||""}`.toLowerCase();
  const high = (project.usefulnessCriteria?.high ?? []).some(s => text.includes(s.toLowerCase()));
  const moderate = !high && (project.usefulnessCriteria?.moderate ?? []).some(s => text.includes(s.toLowerCase()));

  let usefulness = "archive";
  let reason = "Not directly aligned to PRD/usefulness criteria.";
  let nextSteps = null;
  if (high) { usefulness = "HIGH"; reason = "Matches high usefulness criteria."; nextSteps = "Evaluate for direct integration."; }
  else if (moderate) { usefulness = "MODERATE"; reason = "Matches moderate usefulness criteria."; nextSteps = "Monitor/apply soon."; }

  return { project: project.name, projectKey: project.key, usefulness, reason, nextSteps };
}

export async function classify() {
  const run = await latestCuratedRun();
  if (!run) { log("No curated run; skip classify"); await saveJson(STATS_FILE, { count: 0 }); return; }

  const projects = await loadProjects();
  if (!projects.length) { log("No active projects; skip classify"); await saveJson(STATS_FILE, { count: 0 }); return; }

  const state = await loadJson(STATE_FILE, { completedItems: [] });

  let changed = 0;
  for (const item of run.content.items ?? []) {
    const id = item.canonicalId || item.id;
    if (state.completedItems.includes(id)) continue;

    const assignments = projects.map(p => classifyItem(item, p));
    // store under BOTH keys used elsewhere
    item.assignedProjects = assignments.map(a => a.project);
    item.projects = assignments;

    state.completedItems.push(id);
    changed++;
    await saveJson(run.path, run.content);
    await saveJson(STATE_FILE, state);
  }

  await saveJson(STATS_FILE, { count: changed });
  log("Classification complete", { items: changed });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((e)=>{ console.error("Classify failed", e); process.exitCode=1; });
}
