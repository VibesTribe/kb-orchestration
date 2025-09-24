// scripts/lib/kb-sync.js
// Keep knowledge.json in sync with VibesTribe/knowledgebase repo.
// Tracks incremental progress and logs each update.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const CACHE_DIR = path.join(ROOT_DIR, "data", "cache");
const LOG_DIR = path.join(CACHE_DIR, "logs");
const PROGRESS_FILE = path.join(CACHE_DIR, "progress.json");

const KB_OWNER = "VibesTribe";
const KB_REPO = "knowledgebase";
const KNOWLEDGE_FILE = "knowledge.json"; // always at repo root

const kbToken = process.env.KNOWLEDGEBASE_TOKEN;
if (!kbToken) throw new Error("KNOWLEDGEBASE_TOKEN is required");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function logEvent(message, context = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOG_DIR, `${day}.log`);
  const entry = {
    ts: new Date().toISOString(),
    message,
    ...context,
  };
  await ensureDir(LOG_DIR);
  await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
  console.log(`[KB-SYNC] ${message}`, context);
}

// ---- GitHub API helpers ----

async function getFileSha(pathname) {
  const res = await fetch(
    `https://api.github.com/repos/${KB_OWNER}/${KB_REPO}/contents/${pathname}`,
    {
      headers: {
        Authorization: `Bearer ${kbToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to get file SHA: ${res.status}`);
  const json = await res.json();
  return json.sha;
}

async function updateFile(pathname, content, message) {
  const sha = await getFileSha(pathname);
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha,
  };
  const res = await fetch(
    `https://api.github.com/repos/${KB_OWNER}/${KB_REPO}/contents/${pathname}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${kbToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to update ${pathname}: ${res.status} ${txt}`);
  }
  return res.json();
}

// ---- Core Sync Logic ----

export async function pushKnowledge(knowledge) {
  const content = JSON.stringify(knowledge, null, 2);
  await updateFile(
    KNOWLEDGE_FILE,
    content,
    `Update knowledge.json (${new Date().toISOString()})`
  );
  await logEvent("knowledge.json pushed", { count: knowledge.bookmarks?.length || 0 });
}

export async function markProgress(stage, id) {
  const progress = await loadJson(PROGRESS_FILE, {
    ingested: [],
    summarized: [],
    classified: [],
    digests: [],
  });
  if (!progress[stage]) progress[stage] = [];
  if (!progress[stage].includes(id)) {
    progress[stage].push(id);
    await saveJson(PROGRESS_FILE, progress);
    await logEvent("progress updated", { stage, id });
  }
}

export async function pushUpdate(item, stage) {
  // 1. Load current knowledge.json from GitHub
  let knowledge;
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${KB_OWNER}/${KB_REPO}/main/${KNOWLEDGE_FILE}`
    );
    if (!res.ok) throw new Error(`Failed to fetch knowledge.json: ${res.status}`);
    knowledge = await res.json();
  } catch {
    knowledge = { bookmarks: [] };
  }

  // 2. Merge/update item
  const idx = knowledge.bookmarks.findIndex((b) => b.id === item.id);
  if (idx >= 0) {
    knowledge.bookmarks[idx] = { ...knowledge.bookmarks[idx], ...item };
  } else {
    knowledge.bookmarks.push(item);
  }

  // 3. Push overwrite
  await pushKnowledge(knowledge);

  // 4. Update progress
  await markProgress(stage, item.id);

  await logEvent("item pushed", { id: item.id, stage });
}
