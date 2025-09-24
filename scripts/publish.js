// scripts/publish.js
// Handles local publish artifacts. Sync to GitHub is handled later in kb-sync.js.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const PUBLISH_ROOT = path.join(DATA, "publish");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyToPublish(localPath, subdir = "") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(PUBLISH_ROOT, new Date().toISOString().slice(0, 10), stamp, subdir);
  await ensureDir(outDir);
  const fileName = path.basename(localPath);
  const outPath = path.join(outDir, fileName);
  await fs.copyFile(localPath, outPath);
  console.log(`📂 Published ${localPath} → ${outPath}`);
  return outPath;
}

/**
 * Publish artifacts:
 * - knowledge.json
 * - curated/latest/*
 * - digest files (if provided by digest.js)
 *
 * @param {object} options
 *   { digestResult?: { files: { json, txt, html }, dir, payload } }
 */
export async function publish({ digestResult } = {}) {
  console.log("📤 Starting publish step...");

  // 1. Copy knowledge.json
  const knowledgeFile = path.join(DATA, "knowledge.json");
  try {
    await copyToPublish(knowledgeFile);
  } catch {
    console.warn("⚠️ No knowledge.json found to publish");
  }

  // 2. Copy curated/latest if exists
  const curatedDir = path.join(DATA, "curated", "latest");
  try {
    const files = await fs.readdir(curatedDir);
    for (const f of files) {
      await copyToPublish(path.join(curatedDir, f), "curated");
    }
  } catch {
    console.log("ℹ️ No curated/latest directory found, skipping");
  }

  // 3. Copy digest artifacts if provided
  if (digestResult?.files) {
    for (const [label, filePath] of Object.entries(digestResult.files)) {
      try {
        await copyToPublish(filePath, "digest");
      } catch {
        console.warn(`⚠️ Failed to publish digest ${label}`, filePath);
      }
    }
  } else {
    console.log("ℹ️ No digestResult provided, skipping digest publish");
  }

  console.log("✅ Publish step complete (local artifacts only).");
}
