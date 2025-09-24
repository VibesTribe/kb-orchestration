import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./openrouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "cache");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const CURATED = path.join(DATA, "curated");
const STATE_FILE = path.join(CACHE, "enrich-state.json");
const STATS_FILE = path.join(CACHE, "summaries.json");

function log(m, c={}){ console.log(`[${new Date().toISOString()}] ${m}`, Object.keys(c).length?c:""); }
async function ensureDir(p){ await fs.mkdir(p,{recursive:true}); }
async function loadJson(p, fb){ try { return JSON.parse(await fs.readFile(p,"utf8")); } catch { return fb; } }
async function saveJson(p, v){ await ensureDir(path.dirname(p)); await fs.writeFile(p, JSON.stringify(v,null,2), "utf8"); }

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

export async function enrich() {
  const kb = await loadJson(KNOWLEDGE_FILE, { items: [] });
  const state = await loadJson(STATE_FILE, { enrichedIds: [] });
  const run = await latestCuratedRun();
  if (!run) { log("No curated data found; skip enrich"); await saveJson(STATS_FILE, { enriched: 0 }); return; }

  let enriched = 0;
  for (const item of run.content.items) {
    if (!item) continue;
    const id = item.canonicalId || item.id;
    if (state.enrichedIds.includes(id)) continue;
    if (item.summary && item.description) { state.enrichedIds.push(id); continue; }

    // LLM prompt (concise, cheap)
    const messages = [
      { role: "system", content: "You write crisp 2-3 sentence summaries and a one-paragraph description for technical links. Avoid fluff." },
      { role: "user", content: `Title: ${item.title || "(untitled)"}\nURL: ${item.url}\n\nReturn JSON with keys: summary, description.` }
    ];

    try {
      const { content } = await callOpenRouter(messages, { maxTokens: 300, temperature: 0.2 });
      let parsed;
      try { parsed = JSON.parse(content); } catch { parsed = {}; }
      item.summary = parsed.summary || item.summary || "";
      item.description = parsed.description || item.description || "";
      state.enrichedIds.push(id);
      enriched++;

      // also update KB copy
      const kbItem = kb.items.find(x => (x.canonicalId||x.id) === id);
      if (kbItem) { kbItem.summary = item.summary; kbItem.description = item.description; }

      // incremental saves
      await saveJson(run.path, run.content);
      await saveJson(KNOWLEDGE_FILE, kb);
      await saveJson(STATE_FILE, state);
    } catch (e) {
      log("Enrich failed for item", { id, error: e.message });
      // keep progress; let pipeline continue
      await saveJson(STATE_FILE, state);
      break;
    }
  }

  await saveJson(STATS_FILE, { enriched });
  log(`Enriched ${enriched} items`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((e)=>{ console.error("Enrich failed", e); process.exitCode=1; });
}
