import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const OUTPUT_ROOT = path.join(ROOT_DIR, "data", "publish");

/* ------------------ Config ------------------ */
const TARGET_REPO = "VibesTribe/knowledgebase"; // fixed, no env var
const GITHUB_TOKEN = process.env.KNOWLEDGEBASE_TOKEN;

/* ------------------ Helpers ------------------ */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
async function loadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function listDirectories(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
function log(message, context = {}) {
  const ts = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${ts}] ${message}${payload}`);
}

/* ------------------ Main publish step ------------------ */
export async function publish() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip publish");
    return;
  }

  await ensureDir(OUTPUT_ROOT);

  const knowledgeJson = buildKnowledgeJson(curatedRun.content);
  const graphJson = buildGraphJson(curatedRun.content);
  const systemStatus = { generatedAt: new Date().toISOString(), status: "ok" };

  const publishDir = path.join(OUTPUT_ROOT, curatedRun.dayDir, curatedRun.stampDir);
  await ensureDir(publishDir);

  const knowledgePath = path.join(publishDir, "knowledge.json");
  const graphPath = path.join(publishDir, "knowledge.graph.json");
  const statusPath = path.join(publishDir, "system-status.json");

  await fs.writeFile(knowledgePath, JSON.stringify(knowledgeJson, null, 2), "utf8");
  await fs.writeFile(graphPath, JSON.stringify(graphJson, null, 2), "utf8");
  await fs.writeFile(statusPath, JSON.stringify(systemStatus, null, 2), "utf8");

  log("Publish artifacts prepared", {
    dir: publishDir,
    items: knowledgeJson.items.length,
  });

  if (!GITHUB_TOKEN) {
    log("KNOWLEDGEBASE_TOKEN missing; skipping push to repo");
    return;
  }

  await pushToRepo([
    { filename: "knowledge.json", content: knowledgeJson },
    { filename: "knowledge.graph.json", content: graphJson },
    { filename: "system-status.json", content: systemStatus },
  ]);
}

/* ------------------ Builders ------------------ */
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
    assignedProjects: item.assignedProjects,
  }));
  return { generatedAt: curated.generatedAt, items };
}
function buildGraphJson(curated) {
  const nodes = new Map();
  const edges = [];
  const addNode = (id, node) => {
    if (!id) return;
    if (!nodes.has(id)) nodes.set(id, { id, ...node });
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
      publishedAt: item.publishedAt ?? null,
    });
    for (const assignment of item.projects ?? []) {
      const projectId = `project:${assignment.projectKey ?? assignment.project}`;
      addNode(projectId, { type: "project", label: assignment.project });
      addEdge(itemId, projectId, { type: "relevant_to", reason: assignment.reason });
    }
    for (const tag of item.tags ?? []) {
      const tagId = `tag:${tag.toLowerCase()}`;
      addNode(tagId, { type: "tag", label: tag });
      addEdge(itemId, tagId, { type: "tagged_with" });
    }
  }

  return { generatedAt: curated.generatedAt, nodes: [...nodes.values()], edges };
}

/* ------------------ GitHub push ------------------ */
async function pushToRepo(files) {
  for (const { filename, content } of files) {
    const apiUrl = `https://api.github.com/repos/${TARGET_REPO}/contents/${filename}`;
    await commitFile(apiUrl, content, filename);
  }
}
async function commitFile(apiUrl, jsonContent, filename) {
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "kb-orchestration",
  };

  const existing = await fetch(apiUrl, { headers });
  let sha = null;
  if (existing.status === 200) {
    const existingJson = await existing.json();
    sha = existingJson.sha;
  } else if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`Failed to load ${filename}: ${existing.status} ${text}`);
  }

  const response = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `chore: update ${filename}`,
      content: Buffer.from(JSON.stringify(jsonContent, null, 2)).toString("base64"),
      sha,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to push ${filename}: ${response.status} ${await response.text()}`
    );
  }
}

/* ------------------ Helpers ------------------ */
async function getLatestRun(root) {
  const dayDirs = await listDirectories(root);
  if (!dayDirs.length) return null;
  dayDirs.sort().reverse();
  for (const dayDir of dayDirs) {
    const stampDirs = await listDirectories(path.join(root, dayDir));
    stampDirs.sort().reverse();
    for (const stampDir of stampDirs) {
      const itemsPath = path.join(root, dayDir, stampDir, "items.json");
      const content = await loadJson(itemsPath, null);
      if (content) return { dayDir, stampDir, content };
    }
  }
  return null;
}

/* ------------------ Run direct ------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((err) => {
    console.error("Publish step failed", err);
    process.exitCode = 1;
  });
}
