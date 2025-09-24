import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const OUTPUT_ROOT = path.join(ROOT_DIR, "data", "publish");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

const KNOWLEDGEBASE_REPO = process.env.KNOWLEDGEBASE_REPO ?? "VibesTribe/knowledgebase";
const KNOWLEDGEBASE_TOKEN = process.env.KNOWLEDGEBASE_TOKEN;

/* ------------------ Utils ------------------ */
async function ensureDir(d){ await fs.mkdir(d,{recursive:true}); }
async function loadJson(f, fb){ try{ return JSON.parse(await fs.readFile(f,"utf8")); }catch{ return fb; } }
async function saveJson(f, d){ await ensureDir(path.dirname(f)); await fs.writeFile(f, JSON.stringify(d,null,2), "utf8"); }
async function listDirectories(p){ try{ const e=await fs.readdir(p,{withFileTypes:true}); return e.filter(x=>x.isDirectory()).map(x=>x.name);}catch{return[];} }
function log(m,ctx={}){ const ts=new Date().toISOString(); console.log(`[${ts}] ${m}${Object.keys(ctx).length?" "+JSON.stringify(ctx):""}`); }

async function getLatestRun(){
  const days = await listDirectories(CURATED_ROOT); if(!days.length) return null;
  days.sort().reverse();
  for(const d of days){
    const stamps = await listDirectories(path.join(CURATED_ROOT,d));
    stamps.sort().reverse();
    for(const s of stamps){
      const itemsPath = path.join(CURATED_ROOT,d,s,"items.json");
      const content = await loadJson(itemsPath, null);
      if(content) return { dayDir:d, stampDir:s, content };
    }
  }
  return null;
}

/* ------------------ Builders ------------------ */
function buildKnowledgeJson(kb){
  const items = (kb.items ?? []).map(it => ({
    id: it.canonicalId ?? it.id,
    title: it.title,
    url: it.url,
    summary: it.summary,
    description: it.description,
    publishedAt: it.publishedAt,
    sourceType: it.sourceType,
    thumbnail: it.thumbnail ?? null,
    tags: it.tags ?? [],
    projects: it.projects,
    assignedProjects: it.assignedProjects
  }));
  return { generatedAt: new Date().toISOString(), items };
}
function buildGraphJson(kb){
  const nodes = new Map(); const edges = [];
  const addNode=(id,node)=>{ if(id && !nodes.has(id)) nodes.set(id,{id,...node}); };
  const addEdge=(s,t,e)=>{ if(s&&t) edges.push({source:s,target:t,...e}); };

  for(const item of kb.items ?? []){
    const id = item.canonicalId ?? item.id;
    addNode(id,{type:"bookmark",label:item.title??"(untitled)",url:item.url??null,sourceType:item.sourceType,thumbnail:item.thumbnail??null,publishedAt:item.publishedAt??null});
    for(const a of item.projects ?? []){
      const pid = `project:${a.projectKey ?? a.project}`;
      addNode(pid,{type:"project",label:a.project});
      addEdge(id, pid, { type:"relevant_to", usefulness:a.usefulness, reason:a.reason });
    }
    for(const tag of item.tags ?? []){
      const tid = `tag:${String(tag).toLowerCase()}`; addNode(tid,{type:"tag",label:tag}); addEdge(id, tid, {type:"tagged_with"});
    }
  }
  return { generatedAt: new Date().toISOString(), nodes:Array.from(nodes.values()), edges };
}

/* ------------------ Push to knowledgebase ------------------ */
async function commitJsonToRepo(pathInRepo, obj){
  if(!KNOWLEDGEBASE_TOKEN) throw new Error("KNOWLEDGEBASE_TOKEN missing");
  const apiUrl = `https://api.github.com/repos/${KNOWLEDGEBASE_REPO}/contents/${encodeURIComponent(pathInRepo)}`;

  // Check existing
  const head = await fetch(apiUrl, { headers: { Authorization: `Bearer ${KNOWLEDGEBASE_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "kb-orchestration" }});
  let sha = null;
  if(head.status === 200){ const j = await head.json(); sha = j.sha; }
  else if (head.status !== 404){ throw new Error(`Failed to load ${pathInRepo}: ${head.status} ${await head.text()}`); }

  const body = {
    message: `chore: update ${pathInRepo}`,
    content: Buffer.from(JSON.stringify(obj, null, 2)).toString("base64"),
    sha
  };
  const res = await fetch(apiUrl, { method:"PUT", headers: { Authorization:`Bearer ${KNOWLEDGEBASE_TOKEN}`, Accept:"application/vnd.github+json", "User-Agent":"kb-orchestration" }, body: JSON.stringify(body) });
  if(!res.ok) throw new Error(`Failed to push ${pathInRepo}: ${res.status} ${await res.text()}`);
}

/* ------------------ Main ------------------ */
export async function publish(){
  const kb = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const knowledgeJson = buildKnowledgeJson(kb);
  const graphJson = buildGraphJson(kb);

  // Save local artifacts for inspection
  const dayDir = new Date().toISOString().slice(0,10);
  const stampDir = `${Date.now()}`;
  const publishDir = path.join(OUTPUT_ROOT, dayDir, stampDir);
  await ensureDir(publishDir);
  await saveJson(path.join(publishDir, "knowledge.json"), knowledgeJson);
  await saveJson(path.join(publishDir, "knowledge.graph.json"), graphJson);

  log("Publish artifacts prepared", { dir: publishDir, items: knowledgeJson.items.length });

  if(!KNOWLEDGEBASE_TOKEN){ log("KNOWLEDGEBASE_TOKEN missing; skip push"); return; }

  await commitJsonToRepo("knowledge.json", knowledgeJson);
  await commitJsonToRepo("knowledge.graph.json", graphJson);

  // Also upload a minimal system-status so you can see progress
  const run = await getLatestRun();
  const status = {
    generatedAt: new Date().toISOString(),
    lastCuratedRun: run ? `${run.dayDir}/${run.stampDir}` : null,
    knowledgeItems: knowledgeJson.items.length
  };
  await commitJsonToRepo("system-status.json", status);

  log("Publish pushed to knowledgebase", { repo: KNOWLEDGEBASE_REPO });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch(err => { console.error("Publish step failed", err); process.exitCode = 1; });
}
