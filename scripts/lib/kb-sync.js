// scripts/lib/kb-sync.js
// Handles syncing artifacts (knowledge.json, curated runs, digests) back into
// the upstream knowledgebase repo using github-files.js.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { upsertFile } from "./github-files.js"; // ✅ correct import

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");

// Push a single file into the upstream repo
export async function syncFile(localPath, remotePath, message = "Sync file") {
  try {
    const content = await fs.readFile(localPath, "utf8");
    await upsertFile({
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

// Push curated runs upstream (latest directory contents)
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

// Push digest artifacts upstream (JSON, TXT, HTML)
export async function syncDigest(digestResult) {
  if (!digestResult?.files) {
    console.log("ℹ️ No digestResult provided, skipping digest sync");
    return;
  }

  const remoteDir = "digest";
  try {
    for (const [label, filePath] of Object.entries(digestResult.files)) {
      const fileName = path.basename(filePath);
      const remotePath = path.join(remoteDir, fileName);
      await syncFile(filePath, remotePath, `Update digest/${fileName}`);
    }
  } catch (err) {
    console.error("❌ Failed to sync digest artifacts:", err);
    throw err;
  }
}
