// scripts/lib/utils.js
// Common filesystem + JSON helpers for pipeline scripts.

import fs from "node:fs/promises";
import path from "node:path";

// Ensure a directory exists
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// Load JSON from file, or return fallback
export async function loadJson(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Save JSON to file with pretty formatting
export async function saveJsonCheckpoint(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Save plain text to file
export async function saveTextCheckpoint(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

// List subdirectories under a path
export async function listDirectories(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
