// scripts/lib/kb-sync.js
// Centralized upstream writes to the VibesTribe/knowledgebase repo.
// Provides:
//  - pullKnowledge()                           → pull knowledge.json before a run
//  - pushUpdate(localPath, remotePath, msg)    → per-item incremental writes
//  - syncKnowledge()                           → push data/knowledge.json
//  - syncCuratedRun(dir)                       → push files in curated dir
//  - syncDigest(digestResult)                  → push digest JSON/TXT/HTML

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { upsertFile } from "./github-files.js";
import { Octokit } from "octokit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");

// --- NEW: Pull the source-of-truth knowledge.json from knowledgebase repo
export async function pullKnowledge() {
  const local = path.join(DATA, "knowledge.json");
  const owner = "VibesTribe";
  const repo = "knowledgebase";
  const filePath = "knowledge.json";

  const token = process.env.ACTIONS_PAT;
  if (!token) {
    console.warn("⚠️ ACTIONS_PAT missing; cannot pull knowledge.json from knowledgebase repo.");
    return;
  }

  const octokit = new Octokit({ auth: token });

  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    const raw = Array.isArray(res.data) ? null : res.data;
    if (!raw || typeof raw.content !== "string") {
      throw new Error("Unexpected response when fetching knowledge.json");
    }
    const buf = Buffer.from(raw.content, raw.encoding || "base64");
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(local, buf.toString("utf8"), "utf8");
    console.log(`✅ Pulled knowledge.json from ${owner}/${repo} → ${local}`);
  } catch (err) {
    console.error("❌ pullKnowledge failed:", err.message);
    throw err;
  }
}

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

// digest JSON/TXT/HTML — preserve folder structure under /digest/...
export async function syncDigest(digestResult) {
  const filesObj = digestResult?.files ?? null;
  if (!filesObj) {
    console.log("ℹ️ No digestResult provided, skipping digest sync");
    return;
  }

  try {
    for (const filePath of Object.values(filesObj)) {
      // Mirror the relative path under /data to the remote repo
      const relFromData = path.relative(DATA, filePath).replace(/\\/g, "/");
      const remotePath = relFromData; // e.g. "digest/2025-09-29/…/digest.json"
      await pushUpdate(filePath, remotePath, `Update ${remotePath}`);
    }
  } catch (err) {
    console.error("❌ syncDigest failed:", err.message);
    throw err;
  }
}
