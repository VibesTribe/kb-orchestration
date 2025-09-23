import fs from "node:fs/promises";
import path from "node:path";

/**
 * Ensure a directory exists (recursively).
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Save JSON to a file (checkpoint style).
 */
export async function saveJsonCheckpoint(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, "utf8");
}

/**
 * Save plain text to a file (checkpoint style).
 */
export async function saveTextCheckpoint(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf8");
}

/**
 * Save HTML to a file (checkpoint style).
 */
export async function saveHtmlCheckpoint(filePath, html) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, html, "utf8");
}

/**
 * Load a JSON file if it exists, otherwise return fallback.
 */
export async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * List immediate subdirectories of a parent directory.
 */
export async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
