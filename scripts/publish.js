import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDirectories, loadJson, ensureDir } from "./lib/utils.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const OUTPUT_ROOT = path.join(ROOT_DIR, "data", "publish");
const KNOWLEDGEBASE_REPO = process.env.KNOWLEDGEBASE_REPO ?? "VibesTribe/knowledgebase";
const KNOWLEDGEBASE_TOKEN = process.env.KNOWLEDGEBASE_TOKEN;

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

export async function publish() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip publish");
    return;
  }

  await ensureDir(OUTPUT_ROOT);

  const knowledgeJson = buildKnowledgeJson(curatedRun.content);
  const graphJson = buildGraphJson(curatedRun.content);
  const systemStatus = await buildSystemStatus();

  const dayDir = curatedRun.dayDir;
  const stampDir = curatedRun.stampDir;
  const publishDir = path.join(OUTPUT_ROOT, dayDir, stampDir);
  await ensureDir(publishDir);

  const knowledgePath = path.join(publishDir, "knowledge.json");
  const graphPath = path.join(publishDir, "knowledge.graph.json");
  const statusPath = path.join(publishDir, "system-status.json");

  await fs.writeFile(knowledgePath, JSON.stringify(knowledgeJson, null, 2), "utf8");
  await fs.writeFile(graphPath, JSON.stringify(graphJson, null, 2), "utf8");
  await fs.writeFile(statusPath, JSON.stringify(systemStatus, null, 2), "utf8");

  log("Publish artifacts prepared", {
    knowledge: path.relative(ROOT_DIR, knowledgePath),
    graph: path.relative(ROOT_DIR, graphPath),
    status: path.relative(ROOT_DIR, statusPath),
    itemCount: knowledgeJson.items.length
  });

  if (!KNOWLEDGEBASE_TOKEN) {
    log("KNOWLEDGEBASE_TOKEN missing; skipping push to knowledgebase repo");
    return;
  }

  await pushToKnowledgebase([
    { filename: "knowledge.json", content: knowledgeJson },
    { filename: "knowledge.graph.json", content: graphJson },
    { filename: "system-status.json", content: systemStatus }
  ]);
}

function buildKnowledgeJson(curated) {
  const items = (curated.items ?? []).map((item) => ({
    id: item.canonicalId ?? item.id,
    title: item.title,
    url: item.url,
    summary: item.summary,
    description: item.description,
    publishedAt: item.publishedAt,
    sourceType: item.sourceType,
    thumbnail: item.thumbnail ?? null,
    tags: item.tags ?? [],
    projects: item.projects,
    assignedProjects: item.assignedProjects
  }));

  return {
    generatedAt: curated.generatedAt,
    items
  };
}

function buildGraphJson(curated) {
  const nodes = new Map();
  const edges = [];

  const addNode = (id, node) => {
    if (!id) return;
    if (!nodes.has(id)) {
      nodes.set(id, { id, ...node });
    }
  };

  const addEdge = (source, target, edge) => {
    if (!source || !target) return;
    edges.push({ source, target, ...edge });
  };

  for (const item of curated.items ?? []) {
    const itemId = item.canonicalId ?? item.id;
    addNode(itemId, {
      type: "bookmark",
      label: item.title ?? "(untitled)",
      url: item.url ?? null,
      sourceType: item.sourceType,
      thumbnail: item.thumbnail ?? null,
      publishedAt: item.publishedAt ?? null
    });

    for (const assignment of item.projects ?? []) {
      const projectId = `project:${assignment.projectKey ?? assignment.project}`;
      addNode(projectId, {
        type: "project",
        label: assignment.project,
        usefulness: assignment.usefulness
      });
      addEdge(itemId, projectId, {
        type: "relevant_to",
        usefulness: assignment.usefulness,
        reason: assignment.reason
      });
    }

    for (const tag of item.tags ?? []) {
      const tagId = `tag:${tag.toLowerCase()}`;
      addNode(tagId, {
        type: "tag",
        label: tag
      });
      addEdge(itemId, tagId, {
        type: "tagged_with"
      });
    }
  }

  return {
    generatedAt: curated.generatedAt,
    nodes: Array.from(nodes.values()),
    edges
  };
}

async function pushToKnowledgebase(files) {
  for (const { filename, content } of files) {
    const apiUrl = `https://api.github.com/repos/${KNOWLEDGEBASE_REPO}/contents/${filename}`;
    await commitFile(apiUrl, content, filename);
  }
}

async function commitFile(apiUrl, jsonContent, filename) {
  const existing = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${KNOWLEDGEBASE_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "kb-orchestration"
    }
  });

  let sha = null;
  if (existing.status === 200) {
    const existingJson = await existing.json();
    sha = existingJson.sha;
  } else if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`Failed to load ${filename} from knowledgebase repo: ${existing.status} ${text}`);
  }

  const response = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${KNOWLEDGEBASE_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "kb-orchestration"
    },
    body: JSON.stringify({
      message: `chore: update ${filename}`,
      content: Buffer.from(JSON.stringify(jsonContent, null, 2)).toString("base64"),
      sha
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to push ${filename}: ${response.status} ${text}`);
  }

  return response.json();
}

async function getLatestRun(root) {
  const dayDirs = await listDirectories(root);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();

  for (const dayDir of dayDirs) {
    const dayPath = path.join(root, dayDir);
    const stampDirs = await listDirectories(dayPath);
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(dayPath, stampDir, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content) {
        return { dayDir, stampDir, itemsPath, content };
      }
    }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((error) => {
    console.error("Publish step failed", error);
    process.exitCode = 1;
  });
}
