import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./lib/openrouter.js";

/* ------------------ Paths & constants ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const CACHE_ROOT = path.join(ROOT_DIR, "data", "cache");
const STATE_FILE = path.join(CACHE_ROOT, "enrich-state.json");
const KNOWLEDGE_FILE = path.join(ROOT_DIR, "data", "knowledge.json");

const MAX_ITEMS_PER_RUN = Number.parseInt(process.env.ENRICH_MAX_ITEMS ?? "", 10) || 25;

/* ------------------ Utils ------------------ */
async function ensureDir(dir){ await fs.mkdir(dir,{recursive:true}); }
async function loadJson(f, fb){ try{ return JSON.parse(await fs.readFile(f,"utf8")); }catch{ return fb; } }
async function saveJson(f, d){ await ensureDir(path.dirname(f)); await fs.writeFile(f, JSON.stringify(d,null,2), "utf8"); }
async function listDirectories(p){ try{ const e=await fs.readdir(p,{withFileTypes:true}); return e.filter(x=>x.isDirectory()).map(x=>x.name);}catch{return[];} }
function log(msg,ctx={}){const ts=new Date().toISOString();console.log(`[${ts}] ${msg}${Object.keys(ctx).length?" "+JSON.stringify(ctx):""}`);}

/* ------------------ Curated helpers ------------------ */
async function getLatestCuratedRun(){
  const days = await listDirectories(CURATED_ROOT); if(!days.length) return null;
  days.sort().reverse();
  for(const d of days){
    const stamps = await listDirectories(path.join(CURATED_ROOT,d));
    stamps.sort().reverse();
    for(const s of stamps){
      const itemsPath = path.join(CURATED_ROOT,d,s,"items.json");
      const content = await loadJson(itemsPath,null);
      if(content) return { dayDir:d, stampDir:s, itemsPath, content };
    }
  }
  return null;
}
async function ensureCuratedFromKnowledge(){
  const run = await getLatestCuratedRun(); if(run) return run;
  const kb = await loadJson(KNOWLEDGE_FILE, null);
  if(!kb || !Array.isArray(kb.items) || !kb.items.length) return null;
  const dayDir = new Date().toISOString().slice(0,10);
  const stampDir = `bootstrap-${Date.now()}`;
  const itemsPath = path.join(CURATED_ROOT, dayDir, stampDir, "items.json");
  await saveJson(itemsPath, { generatedAt: new Date().toISOString(), items: kb.items });
  return { dayDir, stampDir, itemsPath, content: { generatedAt: new Date().toISOString(), items: kb.items } };
}

/* ------------------ State ------------------ */
async function loadState(){ return loadJson(STATE_FILE, { enrichedIds: [] }); }
async function saveState(s){ await saveJson(STATE_FILE, s); }

/* ------------------ LLM prompt ------------------ */
function buildMessagesFor(item){
  const system = "You are an expert technical editor. Produce concise summaries for a daily engineering digest. Return STRICT JSON with keys: summary, description (description is 'Why it matters: ...').";
  const user = [
    `Title: ${item.title ?? "(untitled)"}`,
    item.url ? `URL: ${item.url}` : "",
    item.summary ? `Existing summary (revise if unclear): ${item.summary}` : "",
    item.description ? `Existing notes: ${item.description}` : "",
    "",
    "Return only JSON like: {\"summary\":\"...\",\"description\":\"Why it matters: ...\"}"
  ].filter(Boolean).join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
function parseStrictJson(text){
  const m = text.match(/\{[\s\S]*\}/);
  const raw = m ? m[0] : text;
  const obj = JSON.parse(raw);
  if(typeof obj.summary !== "string" || typeof obj.description !== "string"){
    throw new Error("Missing keys in JSON (summary, description)");
  }
  return obj;
}

/* ------------------ Main ------------------ */
export async function enrich(){
  let run = await getLatestCuratedRun(); if(!run) run = await ensureCuratedFromKnowledge();
  if(!run){ log("No curated data found; skip enrich"); return; }

  const state = await loadState();
  const items = Array.isArray(run.content.items) ? run.content.items : [];

  const pending = items.filter(it=>{
    const id = it.canonicalId ?? it.id; if(!id) return false;
    if(state.enrichedIds.includes(id)) return false;
    return !(it.summary && it.description);
  });
  if(!pending.length){ log("No items needed enrichment"); return; }

  const limit = Math.min(MAX_ITEMS_PER_RUN, pending.length);
  let processed = 0;

  for(const item of pending.slice(0, limit)){
    const id = item.canonicalId ?? item.id;
    try{
      const messages = buildMessagesFor(item);
      const { content, model } = await callOpenRouter(messages, { temperature: 0.2, maxTokens: 300 });
      const { summary, description } = parseStrictJson(content);
      item.summary = summary; item.description = description;

      await saveJson(run.itemsPath, run.content);   // incremental
      state.enrichedIds.push(id); await saveState(state);

      processed += 1;
      log("Enriched", { id, model });
    }catch(err){
      log("Enrich failed (will retry later)", { id, error: err.message });
    }
  }

  // Mirror back to knowledge.json for site continuity
  try{
    const kb = await loadJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: [] });
    const byId = new Map(kb.items.map(i=>[i.canonicalId??i.id, i]));
    for(const it of run.content.items){
      const k = it.canonicalId ?? it.id;
      const ex = byId.get(k);
      if(ex){ ex.summary = it.summary ?? ex.summary; ex.description = it.description ?? ex.description; }
      else { byId.set(k, it); }
    }
    await saveJson(KNOWLEDGE_FILE, { generatedAt: new Date().toISOString(), items: Array.from(byId.values()) });
  }catch(e){ /* non-fatal */ }

  log("Enrich complete", { processed, cappedBy: MAX_ITEMS_PER_RUN });
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch(err => { console.error("Enrich failed", err); process.exitCode = 1; });
}
