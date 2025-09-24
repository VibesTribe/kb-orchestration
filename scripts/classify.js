import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "classify-state.json");

/* ------------------ Utils ------------------ */
async function ensureDir(d){ await fs.mkdir(d,{recursive:true}); }
async function loadJson(f, fb){ try{ return JSON.parse(await fs.readFile(f,"utf8")); }catch{ return fb; } }
async function saveJson(f, d){ await ensureDir(path.dirname(f)); await fs.writeFile(f, JSON.stringify(d,null,2), "utf8"); }
async function listDirectories(p){ try{ const e=await fs.readdir(p,{withFileTypes:true}); return e.filter(x=>x.isDirectory()).map(x=>x.name);}catch{return[];} }
function log(m,ctx={}){ const ts=new Date().toISOString(); console.log(`[${ts}] ${m}${Object.keys(ctx).length?" "+JSON.stringify(ctx):""}`); }

/* ------------------ Curated helpers ------------------ */
async function getLatestCuratedRun(){
  const days = await listDirectories(CURATED_ROOT); if(!days.length) return null;
  days.sort().reverse();
  for(const d of days){
    const stamps = await listDirectories(path.join(CURATED_ROOT,d));
    stamps.sort().reverse();
    for(const s of stamps){
      const itemsPath = path.join(CURATED_ROOT,d,s,"items.json");
      const content = await loadJson(itemsPath, null);
      if(content) return { dayDir:d, stampDir:s, itemsPath, content };
    }
  }
  return null;
}

/* ------------------ Projects ------------------ */
async function loadProjects(){
  const dirs = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for(const dir of dirs){
    const cfg = await loadJson(path.join(PROJECTS_ROOT, dir, "project.json"), null);
    if(!cfg) continue;
    if (cfg.status && String(cfg.status).toLowerCase() !== "active") continue;
    const prd = await (async()=>{ try{ return await fs.readFile(path.join(PROJECTS_ROOT, dir, "prd.md"), "utf8"); }catch{ return ""; }})();
    projects.push({ key: dir, prd, ...cfg });
  }
  return projects;
}

/* ------------------ Heuristic classifier ------------------ */
function classifyItemForProject(item, project){
  const text = [
    item.title ?? "", item.summary ?? "", item.description ?? "",
    (item.tags ?? []).join(" "), project.prd ?? "", (project.objectives ?? []).join(" ")
  ].join("\n").toLowerCase();

  const high = (project.usefulnessCriteria?.high ?? []).some(k => text.includes(k.toLowerCase()));
  const moderate = (project.usefulnessCriteria?.moderate ?? []).some(k => text.includes(k.toLowerCase()));

  if (high) return { project: project.name ?? project.key, projectKey: project.key, usefulness: "HIGH", reason: "Matches high usefulness criteria.", nextSteps: "Evaluate for integration." };
  if (moderate) return { project: project.name ?? project.key, projectKey: project.key, usefulness: "MODERATE", reason: "Matches moderate usefulness criteria.", nextSteps: "Monitor and adapt soon." };
  return { project: project.name ?? project.key, projectKey: project.key, usefulness: "ARCHIVE", reason: "Not actionable for current quarter.", nextSteps: "" };
}

/* ------------------ State ------------------ */
async function loadState(){ return loadJson(STATE_FILE, { done: [] }); }
async function saveState(s){ await saveJson(STATE_FILE, s); }

/* ------------------ Main ------------------ */
export async function classify(){
  const run = await getLatestCuratedRun();
  if(!run){ log("No curated run; skip classify"); return; }

  const projects = await loadProjects();
  if(!projects.length){ log("No active projects; skip classify"); return; }

  const state = await loadState();
  let updated = 0;

  for(const item of (run.content.items ?? [])){
    const id = item.canonicalId ?? item.id; if(!id) continue;
    if (state.done.includes(id)) continue;

    const assignments = projects.map(p => classifyItemForProject(item, p));
    item.projects = assignments;
    item.assignedProjects = assignments.map(a => a.project);

    await saveJson(run.itemsPath, run.content); // incremental safety
    state.done.push(id); await saveState(state);
    updated += 1;
  }

  if(updated === 0) log("No items required classification");
  else log("Classification complete", { items: updated });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch(err => { console.error("Classify step failed", err); process.exitCode = 1; });
}
