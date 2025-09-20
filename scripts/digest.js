import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

function log(message, context = {}) {
  const timestamp = new Date().toISOString();
  const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] ${message}${payload}`);
}

export async function digest() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip digest");
    return;
  }

  const projects = await loadProjects();
  const projectMap = new Map(projects.map((project) => [project.key, project]));

  const digestDir = path.join(DIGEST_ROOT, curatedRun.dayDir, curatedRun.stampDir);
  await ensureDir(digestDir);

  const digestPayload = buildDigestPayload(curatedRun.content, projectMap);
  if (!digestPayload.projects.length) {
    log("No High or Moderate items; skipping email but saving digest payload", { digestDir });
  }

  const jsonPath = path.join(digestDir, "digest.json");
  await fs.writeFile(jsonPath, JSON.stringify(digestPayload, null, 2), "utf8");

  const textContent = renderTextDigest(digestPayload);
  const textPath = path.join(digestDir, "digest.txt");
  await fs.writeFile(textPath, textContent, "utf8");

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath)
  });

  if (!BREVO_API_KEY) {
    log("BREVO_API_KEY missing; skipping email send");
    return;
  }

  const recipients = BREVO_TO.split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length) {
    log("BREVO_TO not configured; skipping email send");
    return;
  }

  if (!digestPayload.projects.length) {
    log("Digest contains no actionable items; skipping email send");
    return;
  }

  await sendBrevoEmail({
    subject: digestPayload.subject,
    textContent,
    recipients
  });
}

function buildDigestPayload(curated, projectMap) {
  const projects = [];

  for (const [projectKey, project] of projectMap.entries()) {
    const high = [];
    const moderate = [];

    for (const item of curated.items ?? []) {
      const assignment = (item.projects ?? []).find((entry) => entry.projectKey === projectKey || entry.project === project.name);
      if (!assignment) continue;

      if (assignment.usefulness === "HIGH") {
        high.push(buildDigestEntry(item, assignment));
      } else if (assignment.usefulness === "MODERATE") {
        moderate.push(buildDigestEntry(item, assignment));
      }
    }

    if (!high.length && !moderate.length) continue;

    projects.push({
      key: projectKey,
      name: project.name,
      summary: project.summary,
      high,
      moderate,
      changelog: project.changelog ?? []
    });
  }

  const totalHigh = projects.reduce((sum, project) => sum + project.high.length, 0);
  const totalModerate = projects.reduce((sum, project) => sum + project.moderate.length, 0);

  const subject = `Knowledgebase Digest – ${totalHigh} High / ${totalModerate} Moderate items`;

  return {
    generatedAt: new Date().toISOString(),
    subject,
    totalHigh,
    totalModerate,
    projects
  };
}

function buildDigestEntry(item, assignment) {
  return {
    title: item.title ?? "(untitled)",
    url: item.url ?? null,
    summary: item.summary ?? item.description ?? "",
    usefulness: assignment.usefulness,
    reason: assignment.reason ?? "",
    nextSteps: assignment.nextSteps ?? "",
    publishedAt: item.publishedAt ?? null,
    sourceType: item.sourceType ?? "unknown"
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

  for (const project of payload.projects) {
    lines.push(`# ${project.name}`);
    if (project.summary) {
      lines.push(`Summary: ${project.summary}`);
    }
    lines.push("");

    if (project.high.length) {
      lines.push("## High Priority");
      for (const entry of project.high) {
        lines.push(formatEntry(entry));
      }
      lines.push("");
    }

    if (project.moderate.length) {
      lines.push("## Moderate Priority");
      for (const entry of project.moderate) {
        lines.push(formatEntry(entry));
      }
      lines.push("");
    }

    if (project.changelog.length) {
      lines.push("## Recent Changelog Notes");
      for (const note of project.changelog.slice(0, 5)) {
        lines.push(`- ${note}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatEntry(entry) {
  const lines = [];
  lines.push(`- **${entry.title}** (${entry.usefulness})`);
  if (entry.url) {
    lines.push(`  URL: ${entry.url}`);
  }
  if (entry.summary) {
    lines.push(`  Summary: ${entry.summary}`);
  }
  if (entry.reason) {
    lines.push(`  Why it matters: ${entry.reason}`);
  }
  if (entry.nextSteps) {
    lines.push(`  Next steps: ${entry.nextSteps}`);
  }
  if (entry.publishedAt) {
    lines.push(`  Published: ${entry.publishedAt}`);
  }
  lines.push("  Source: " + entry.sourceType);
  return lines.join("\n");
}

async function sendBrevoEmail({ subject, textContent, recipients }) {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          name: BREVO_FROM_NAME,
          email: BREVO_FROM_EMAIL
        },
        to: recipients.map((email) => ({ email })),
        subject,
        textContent
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Brevo error: ${response.status} ${text}`);
    }

    log("Digest email sent", { recipients: recipients.length });
  } catch (error) {
    log("Failed to send Brevo email", { error: error.message });
  }
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

async function loadProjects() {
  const entries = await listDirectories(PROJECTS_ROOT);
  const projects = [];
  for (const dir of entries) {
    const projectDir = path.join(PROJECTS_ROOT, dir);
    const configPath = path.join(projectDir, "project.json");
    const prdPath = path.join(projectDir, "prd.md");
    const changelogPath = path.join(projectDir, "changelog.md");

    const config = await loadJson(configPath, null);
    if (!config) continue;

    const changelog = await loadChangelog(changelogPath);

    projects.push({
      key: dir,
      changelog,
      ...config
    });
  }
  return projects;
}

async function loadChangelog(pathname) {
  try {
    const text = await fs.readFile(pathname, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadJson(filePath, fallback) {
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
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  digest().catch((error) => {
    console.error("Digest step failed", error);
    process.exitCode = 1;
  });
}
