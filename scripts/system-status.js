import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE = path.join(ROOT, "data", "cache");

async function loadJson(p, fb = null) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return fb; }
}
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

export async function buildSystemStatus() {
  const state = await loadJson(path.join(CACHE, "pipeline-state.json"), { completed: [] });
  const summaries = await loadJson(path.join(CACHE, "summaries.json"), { enriched: 0 });
  const status = {
    generatedAt: new Date().toISOString(),
    pipeline: {
      lastRunStep: state.completed[state.completed.length - 1] ?? null,
      completedSteps: state.completed,
      stats: {
        ingested: (await loadJson(path.join(CACHE, "ingest-stats.json"), { count: 0 })).count,
        enriched: summaries.enriched ?? 0,
        classified: (await loadJson(path.join(CACHE, "classify-stats.json"), { count: 0 })).count,
        digests: (await loadJson(path.join(CACHE, "digest-stats.json"), { count: 0 })).count,
        published: (await loadJson(path.join(CACHE, "publish-stats.json"), { count: 0 })).count
      }
    },
    knowledgebase: await loadJson(path.join(ROOT, "data", "knowledge.json"), null),
    digest: await loadJson(path.join(CACHE, "last-digest.json"), null)
  };

  await ensureDir(CACHE);
  const out = path.join(CACHE, "system-status.json");
  await fs.writeFile(out, JSON.stringify(status, null, 2), "utf8");
  console.log(`✅ System status written ${out}`, status);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildSystemStatus().catch((e) => {
    console.error("System-status failed", e);
    process.exitCode = 1;
  });
}
