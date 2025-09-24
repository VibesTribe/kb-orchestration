// scripts/lib/kb-sync.js
// Handles syncing local artifacts (knowledge.json, curated runs, digests, etc.)
// back into the upstream knowledgebase repo.
// Uses github-files.js (for upsertFile) instead of github-secrets.js (which is only for secret encryption).

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { upsertFile } from "./github-files.js"; // ✅ fixed import

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");

// Push a single file into the upstream repo
export async function syncFile(localPath, remotePath, message = "Sync file") {
  try {
    const content = await fs.readFile(localPath, "utf8");
    await upsertFile({
      owner: "VibesTribe",
      repo: "knowledgebase",
      path: remotePath,
      content,
      message,
    });
    console.log(`✅ Synced ${localPath} → ${remotePath}`);
  } catch (err) {
    console.error(`❌ Failed to sync ${localPath}:`, err);
    throw err;
  }
}

// Push knowledge.json upstream
export async function syncKnowledge() {
  const local = path.join(DATA, "knowledge.json");
  const remote = "knowledge.json";
  await syncFile(local, remote, "Update knowledge.json");
}

// Push curated runs upstream (optional, controlled by caller)
export async function syncCuratedRun(curatedDir) {
  const remoteDir = "curated";
  try {
    const files = await fs.readdir(curatedDir);
    for (const f of files) {
      const localPath = path.join(curatedDir, f);
      const remotePath = path.join(remoteDir, f);
      await syncFile(localPath, remotePath, `Update curated/${f}`);
    }
  } catch (err) {
    console.error(`❌ Failed to sync curated run:`, err);
    throw err;
  }
}
