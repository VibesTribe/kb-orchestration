import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveJsonCheckpoint, saveTextCheckpoint, ensureDir, loadJson, listDirectories } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// Where we write digest artifacts locally for archival
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");

// Projects (for names, summaries, and optional changelog)
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

// Secrets (email)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO || "";

// Single source of truth path
const KNOWLEDGE_JSON_PATH =
  process.env.KNOWLEDGE_JSON_PATH || path.resolve(ROOT_DIR, "..", "knowledgebase", "knowledge.json");

function log(message, context = {}) {
  const ts = new Date().toISOString();
  const ctx = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${ts}] ${message}${ctx}`);
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

async function checkpointKnowledge(kb) {
  await saveJsonCheckpoint(KNOWLEDGE_JSON_PATH, kb);
}

async function loadProjects() {
  const dirs = await listDirectories(PROJECTS_ROOT);
  const out = [];
  for (const dir of dirs) {
    const projectDir = path.join(PROJECTS_ROOT, dir);
    const cfgPath = path.join(projectDir, "project.json");
    const prdPath = path.join(projectDir, "prd.md");
    const changelogPath = path.join(projectDir, "changelog.md");

    const cfg = await loadJson(cfgPath, null);
    if (!cfg) continue;

    const changelog = await loadChangelog(changelogPath);
    const prdText = await fs.readFile(prdPath, "utf8").catch(() => "");

    out.push({
      key: dir,
      changelog,
      context: prdText.slice(0, 4000),
      ...cfg,
    });
  }
  return out;
}

async function loadChangelog(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function collectForProject(kb, project) {
  const high = [];
  const moderate = [];

  for (const item of kb.items) {
    if (!Array.isArray(item.classifications)) continue;
    const hit = item.classifications.find(
      (c) => c.projectKey === project.key || c.project === project.name
    );
    if (!hit) continue;

    if (hit.usefulness === "HIGH") {
      high.push(buildDigestEntry(item, hit));
    } else if (hit.usefulness === "MODERATE") {
      moderate.push(buildDigestEntry(item, hit));
    }
  }
  return { high, moderate };
}

function buildDigestEntry(item, cls) {
  return {
    id: item.canonicalId || item.id || item.url || "",
    title: item.title || "(untitled)",
    url: item.url || null,
    summary: (item.enriched?.summary || item.summary || item.description || "").slice(0, 1200),
    usefulness: cls.usefulness,
    reason: cls.reason || "",
    nextSteps: cls.nextSteps || "",
    publishedAt: item.publishedAt || null,
    sourceType: item.sourceType || "unknown",
  };
}

function renderTextDigest(payload) {
  const lines = [];
  lines.push(payload.subject);
  lines.push("");
  lines.push(`Generated at: ${payload.generatedAt}`);
  lines.push(`Total High: ${payload.totalHigh}`);
  lines.push(`Total Moderate: ${payload.totalModerate}`);
  lines.push("");

  for (const p of payload.projects) {
    lines.push(`# ${p.name}`);
    if (p.summary) lines.push(`Summary: ${p.summary}`);
    lines.push("");

    if (p.high.length) {
      lines.push("## High Priority");
      for (const e of p.high) lines.push(formatEntry(e));
      lines.push("");
    }
    if (p.moderate.length) {
      lines.push("## Moderate Priority");
      for (const e of p.moderate) lines.push(formatEntry(e));
      lines.push("");
    }
    if (p.changelog?.length) {
      lines.push("## Recent Changelog Notes");
      for (const note of p.changelog.slice(0, 5)) lines.push(`- ${note}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function formatEntry(e) {
  const L = [];
  L.push(`- **${e.title}** (${e.usefulness})`);
  if (e.url) L.push(`  URL: ${e.url}`);
  if (e.summary) L.push(`  Summary: ${e.summary}`);
  if (e.reason) L.push(`  Why it matters: ${e.reason}`);
  if (e.nextSteps) L.push(`  Next steps: ${e.nextSteps}`);
  if (e.publishedAt) L.push(`  Published: ${e.publishedAt}`);
  L.push(`  Source: ${e.sourceType}`);
  return L.join("\n");
}

async function sendBrevoEmail({ subject, textContent, recipients }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
      to: recipients.map((email) => ({ email })),
      subject,
      textContent,
    }),
  });
  if (!res.ok) {
    throw new Error(`Brevo error: ${res.status} ${await res.text()}`);
  }
}

export async function digest() {
  // Load current knowledge & projects
  const kb = await loadKnowledge();
  const projects = await loadProjects();
  if (!kb.items.length || !projects.length) {
    log("Nothing to digest (no items or no projects).");
    return;
  }

  // Prepare digest folders
  const day = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const digestDir = path.join(DIGEST_ROOT, day, stamp);
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");

  // Resume from checkpoint if present
  const digestPayload =
    (await loadJson(jsonPath, null)) || {
      generatedAt: new Date().toISOString(),
      subject: "",
      totalHigh: 0,
      totalModerate: 0,
      projects: [],
    };

  // Build/append incrementally per project (only HIGH/MODERATE)
  for (const project of projects) {
    if (digestPayload.projects.some((p) => p.key === project.key)) continue;

    const { high, moderate } = collectForProject(kb, project);
    // skip projects without any High/Moderate
    if (!high.length && !moderate.length) continue;

    const projectDigest = {
      key: project.key,
      name: project.name,
      summary: project.summary || "",
      high,
      moderate,
      changelog: project.changelog || [],
    };

    digestPayload.projects.push(projectDigest);
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;
    digestPayload.subject = `Knowledgebase Digest – ${digestPayload.totalHigh} High / ${digestPayload.totalModerate} Moderate items`;

    // Checkpoint artifacts after each project
    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));

    // ALSO: append/update minimal digest record inside knowledge.json so site can list/browse digests even if email fails
    const compact = {
      id: `${day}/${stamp}`,
      generatedAt: digestPayload.generatedAt,
      subject: digestPayload.subject,
      totals: { high: digestPayload.totalHigh, moderate: digestPayload.totalModerate },
      projects: digestPayload.projects.map((p) => ({
        key: p.key,
        name: p.name,
        highIds: p.high.map((e) => e.id),
        moderateIds: p.moderate.map((e) => e.id),
      })),
    };

    // Upsert digest record by id
    const idx = kb.digests.findIndex((d) => d.id === compact.id);
    if (idx === -1) kb.digests.push(compact);
    else kb.digests[idx] = compact;

    await checkpointKnowledge(kb);
    log("Checkpoint saved", { project: project.name });
  }

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath),
  });

  // Email (optional; only if we actually have content)
  const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
    return;
  }
  if (!recipients.length) {
    log("BREVO_TO not configured; skipping email send");
    return;
  }
  if (!digestPayload.projects.length) {
    log("Digest contains no High/Moderate items; skipping email send");
    return;
  }

  try {
    await sendBrevoEmail({
      subject: digestPayload.subject,
      textContent: renderTextDigest(digestPayload),
      recipients,
    });
    log("Digest email sent", { recipients: recipients.length });
  } catch (err) {
    log("Failed to send Brevo email", { error: err.message });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((err) => {
    console.error("Digest step failed", err);
    process.exitCode = 1;
  });
}
