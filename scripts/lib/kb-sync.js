// scripts/lib/kb-sync.js
// Centralized upstream writes to the VibesTribe/knowledgebase repo.
// Provides:
//  - pushUpdate(localPath, remotePath, message)  → per-item incremental writes
//  - syncKnowledge()                             → push data/knowledge.json
//  - syncCuratedRun(dir)                         → push files in curated dir
//  - syncDigest(digestResult)                    → push digest JSON/TXT/HTML

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { upsertFile } from "./github-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");

// Per-item / per-file update (incremental persistence)
export async function pushUpdate(localPath, remotePath, message = "Update file") {
  try {
    const content = await fs.readFile(localPath, "utf8");
    await upsertFile({ path: remotePath, content, message });
    console.log(`✅ pushUpdate: ${localPath} → ${remotePath}`);
  } catch (err) {
    console.error(`❌ pushUpdate failed for ${localPath}:`, err.message);
    throw err;
  }
}

// knowledge.json
export async function syncKnowledge() {
  const local = path.join(DATA, "knowledge.json");
  const remote = "knowledge.json";
  await pushUpdate(local, remote, "Update knowledge.json");
}

// curated/latest/*
export async function syncCuratedRun(curatedDir) {
  const remoteDir = "curated";
  try {
    const files = await fs.readdir(curatedDir);
    for (const f of files) {
      const localPath = path.join(curatedDir, f);
      const remotePath = path.join(remoteDir, f);
      await pushUpdate(localPath, remotePath, `Update curated/${f}`);
    }
  } catch (err) {
    console.error("❌ syncCuratedRun failed:", err.message);
    throw err;
  }
}

// digest JSON/TXT/HTML
export async function syncDigest(digestResult) {
  if (!digestResult?.files) {
    console.log("ℹ️ No digestResult provided, skipping digest sync");
    return;
  }
  const remoteDir = "digest";
  try {
    for (const filePath of Object.values(digestResult.files)) {
      const name = path.basename(filePath);
      await pushUpdate(filePath, path.join(remoteDir, name), `Update digest/${name}`);
    }
  } catch (err) {
    console.error("❌ syncDigest failed:", err.message);
    throw err;
  }
}
