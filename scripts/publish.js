import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemStatus } from "./system-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLISH_DIR = path.join(DATA_DIR, "publish");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");

const GITHUB_API = "https://api.github.com";
const OWNER = process.env.GITHUB_REPOSITORY?.split("/")[0];
const REPO = process.env.GITHUB_REPOSITORY?.split("/")[1];
const TOKEN = process.env.ACTIONS_PAT;

function log(message, ctx = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`, Object.keys(ctx).length ? ctx : "");
}

/* ---------- Helpers ---------- */
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

/* ---------- GitHub Push ---------- */
async function commitJsonToRepo(filePath, destPath, message) {
  if (!TOKEN) throw new Error("ACTIONS_PAT is not configured");
  if (!OWNER || !REPO) throw new Error("GITHUB_REPOSITORY not set");

  const content = await fs.readFile(filePath, "utf8");
  const base64Content = Buffer.from(content).toString("base64");

  // Does the file already exist?
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${destPath}`;
  let sha = null;
  const getResp = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "kb-orchestration" },
  });
  if (getResp.ok) {
    const json = await getResp.json();
    sha = json.sha;
  }

  const putResp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": "kb-orchestration",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: base64Content,
      sha,
      branch: "main",
    }),
  });

  if (!putResp.ok) {
    throw new Error(`Failed to push ${destPath}: ${putResp.status} ${await putResp.text()}`);
  }
  log("Committed to repo", { destPath });
}

/* ---------- Main ---------- */
export async function publish() {
  const dayDir = new Date().toISOString().slice(0, 10);
  const stampDir = Date.now().toString();
  const publishDir = path.join(PUBLISH_DIR, dayDir, stampDir);
  await ensureDir(publishDir);

  const knowledge = await loadJson(KNOWLEDGE_FILE, null);
  if (!knowledge) {
    log("No knowledge.json found; skipping publish");
    return;
  }

  const localCopy = path.join(publishDir, "knowledge.json");
  await fs.writeFile(localCopy, JSON.stringify(knowledge, null, 2), "utf8");

  // Push to repo
  await commitJsonToRepo(
    localCopy,
    "data/knowledge.json",
    `Publish knowledge.json ${dayDir} ${stampDir}`
  );

  // Update system status
  await buildSystemStatus({ published: knowledge.items?.length || 0 });

  log("Publish complete", { dir: publishDir, items: knowledge.items?.length || 0 });
}

/* ---------- Run direct ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((err) => {
    console.error("Publish failed", err);
    process.exitCode = 1;
  });
}
