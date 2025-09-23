import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveJsonCheckpoint } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// Where we optionally stash local publish artifacts for debugging
const OUTPUT_ROOT = path.join(ROOT_DIR, "data", "publish");

// Secrets / variables from GitHub Actions
const KNOWLEDGEBASE_TOKEN = process.env.KNOWLEDGEBASE_TOKEN;
const KNOWLEDGEBASE_REPO = process.env.KNOWLEDGEBASE_REPO || "VibesTribe/knowledgebase";
const KNOWLEDGE_JSON_PATH =
  process.env.KNOWLEDGE_JSON_PATH || path.resolve(ROOT_DIR, "..", "knowledgebase", "knowledge.json");

function log(message, context = {}) {
  const ts = new Date().toISOString();
  const ctx = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${ts}] ${message}${ctx}`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadKnowledge() {
  try {
    const raw = await fs.readFile(KNOWLEDGE_JSON_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!Array.isArray(json.items)) json.items = [];
    if (!Array.isArray(json.digests)) json.digests = [];
    if (!Array.isArray(json.runs)) json.runs = [];
    return json;
  } catch {
    return { items: [], digests: [], runs: [] };
  }
}

function buildGraphFromKnowledge(kb) {
  const nodes = new Map(); // id -> node
  const edges = [];

  const addNode = (id, node) => {
    if (!id) return;
    if (!nodes.has(id)) nodes.set(id, { id, ...node });
  };
  const addEdge = (source, target, extra = {}) => {
    if (!source || !target) return;
    edges.push({ source, target, ...extra });
  };

  for (const item of kb.items) {
    const itemId = item.canonicalId || item.id || item.url || null;
    addNode(itemId, {
      type: "bookmark",
      label: item.title || "(untitled)",
      url: item.url || null,
      sourceType: item.sourceType || "unknown",
      publishedAt: item.publishedAt || null,
      thumbnail: item.thumbnail || null,
    });

    // tags
    for (const tag of item.tags || []) {
      const tagId = `tag:${String(tag).toLowerCase()}`;
      addNode(tagId, { type: "tag", label: tag });
      addEdge(itemId, tagId, { type: "tagged_with" });
    }

    // project classifications
    for (const cls of item.classifications || []) {
      const projKey = cls.projectKey || cls.project || "unknown";
      const projectId = `project:${projKey}`;
      addNode(projectId, {
        type: "project",
        label: cls.project || projKey,
        usefulness: cls.usefulness,
      });
      addEdge(itemId, projectId, {
        type: "relevant_to",
        usefulness: cls.usefulness,
        reason: cls.reason || "",
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: Array.from(nodes.values()),
    edges,
  };
}

async function commitFileToRepo({ repo, token, pathInRepo, jsonContent, message }) {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(pathInRepo)}`;

  // Get existing SHA if file exists
  const existingRes = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "kb-orchestration",
    },
  });

  let sha = null;
  if (existingRes.status === 200) {
    const ex = await existingRes.json();
    sha = ex.sha;
  } else if (existingRes.status !== 404) {
    const text = await existingRes.text();
    throw new Error(`Failed to read ${pathInRepo}: ${existingRes.status} ${text}`);
  }

  const body = {
    message: message || `chore: update ${pathInRepo}`,
    content: Buffer.from(JSON.stringify(jsonContent, null, 2)).toString("base64"),
    sha: sha || undefined,
  };

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "kb-orchestration",
    },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`Failed to push ${pathInRepo}: ${putRes.status} ${text}`);
  }
  return putRes.json();
}

export async function publish() {
  // Load current knowledge (the single source of truth)
  const kb = await loadKnowledge();
  if (!kb.items.length) {
    log("No items in knowledge.json; nothing to publish");
    return;
  }

  // Build graph from knowledge
  const graph = buildGraphFromKnowledge(kb);

  // Optional: store local publish artifacts for inspection
  const day = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const publishDir = path.join(OUTPUT_ROOT, day, stamp);
  await ensureDir(publishDir);
  await saveJsonCheckpoint(path.join(publishDir, "knowledge.json"), kb);
  await saveJsonCheckpoint(path.join(publishDir, "knowledge.graph.json"), graph);

  log("Prepared publish artifacts", {
    items: kb.items.length,
    digests: kb.digests.length,
    runs: kb.runs.length,
  });

  // Push to knowledgebase repo so the site rebuilds
  if (!KNOWLEDGEBASE_TOKEN) {
    log("KNOWLEDGEBASE_TOKEN missing; skipping push to knowledgebase repo");
    return;
  }

  const knowledgeCommit = await commitFileToRepo({
    repo: KNOWLEDGEBASE_REPO,
    token: KNOWLEDGEBASE_TOKEN,
    pathInRepo: "knowledge.json",
    jsonContent: kb,
    message: "chore: update knowledge.json",
  });

  const graphCommit = await commitFileToRepo({
    repo: KNOWLEDGEBASE_REPO,
    token: KNOWLEDGEBASE_TOKEN,
    pathInRepo: "knowledge.graph.json",
    jsonContent: graph,
    message: "chore: update knowledge.graph.json",
  });

  log("Pushed artifacts to knowledgebase", {
    knowledgeSha: knowledgeCommit?.content?.sha,
    graphSha: graphCommit?.content?.sha,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((err) => {
    console.error("Publish step failed", err);
    process.exitCode = 1;
  });
}
