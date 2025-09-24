// scripts/publish.js
// Handles local publish artifacts and delegates upstream sync to kb-sync.js

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const PUBLISH_ROOT = path.join(DATA, "publish");

/**
 * Save a JSON object to a file
 */
async function saveJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}

/**
 * Copy file into publish dir with timestamped folder
 */
async function copyToPublish(localPath, subdir = "") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(PUBLISH_ROOT, new Date().toISOString().slice(0, 10), stamp, subdir);
  await fs.mkdir(outDir, { recursive: true });
  const fileName = path.basename(localPath);
  const outPath = path.join(outDir, fileName);
  await fs.copyFile(localPath, outPath);
  console.log(`📂 Published ${localPath} → ${outPath}`);
  return outPath;
}

/**
 * Main publish routine
 * - Copies knowledge.json
 * - Copies curated/latest if present
 * - Leaves upstream sync to run-pipeline.js (via kb-sync.js)
 */
export async function publish() {
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

  console.log("✅ Publish step complete (local artifacts only).");
}
