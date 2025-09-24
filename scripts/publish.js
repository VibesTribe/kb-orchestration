import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "cache");
const PUBLISH_ROOT = path.join(DATA, "publish");
const CURATED = path.join(DATA, "curated");
const KNOWLEDGE_FILE = path.join(DATA, "knowledge.json");
const STATS_FILE = path.join(CACHE, "publish-stats.json");

function log(m,c={}){ console.log(`[${new Date().toISOString()}] ${m}`, Object.keys(c).length?c:""); }
async function ensureDir(p){ await fs.mkdir(p,{recursive:true}); }
async function loadJson(p, fb){ try { return JSON.parse(await fs.readFile(p,"utf8")); } catch { return fb; } }
async function saveJson(p, v){ await ensureDir(path.dirname(p)); await fs.writeFile(p, JSON.stringify(v,null,2), "utf8"); }

function nowStamp(){ return Date.now().toString(); }
function dayDir(){ return new Date().toISOString().slice(0,10); }

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
      if (json) return { dayDir: d, stampDir: s, path: f, content: json };
    }
  }
  return null;
}

export async function publish() {
  const dir = path.join(PUBLISH_ROOT, dayDir(), nowStamp());
  await ensureDir(dir);

  // always copy latest knowledge.json so the site can read it
  try {
    const kb = await loadJson(KNOWLEDGE_FILE, { items: [] });
    await saveJson(path.join(dir, "knowledge.json"), kb);
  } catch { /* ignore */ }

  // also ship the latest curated run for the site
  const run = await latestCuratedRun();
  if (run) {
    await fs.copyFile(run.path, path.join(dir, "curated-items.json"));
  }

  // cheap manifest for the site or debugging
  await saveJson(path.join(dir, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    knowledgeCopied: true,
    curatedCopied: !!run
  });

  await saveJson(STATS_FILE, { count: 1 });
  log("Publish artifacts prepared", { dir, items: (run?.content?.items ?? []).length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((e)=>{ console.error("Publish failed", e); process.exitCode=1; });
}
