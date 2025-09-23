import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveJsonCheckpoint,
  saveTextCheckpoint,
  ensureDir,
  loadJson,
  listDirectories
} from "./utils.js";

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

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");
  const htmlPath = path.join(digestDir, "digest.html");

  const digestPayload =
    (await loadJson(jsonPath, null)) || {
      generatedAt: new Date().toISOString(),
      subject: "",
      totalHigh: 0,
      totalModerate: 0,
      projects: []
    };

  for (const [projectKey, project] of projectMap.entries()) {
    if (digestPayload.projects.some((p) => p.key === projectKey)) continue;

    const { high, moderate } = collectItemsForProject(curatedRun.content, project);
    if (!high.length && !moderate.length) continue;

    const projectDigest = {
      key: projectKey,
      name: project.name,
      summary: project.summary,
      high,
      moderate,
      changelog: project.changelog ?? []
    };

    digestPayload.projects.push(projectDigest);
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;

    digestPayload.subject = `Knowledgebase Digest – ${digestPayload.totalHigh} High / ${digestPayload.totalModerate} Moderate items`;

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveTextCheckpoint(htmlPath, renderHtmlDigest(digestPayload));

    log("Checkpoint saved", { project: project.name });
  }

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath),
    html: path.relative(ROOT_DIR, htmlPath)
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
    textContent: renderTextDigest(digestPayload),
    htmlContent: renderHtmlDigest(digestPayload),
    recipients
  });
}

function collectItemsForProject(curated, project) {
  const high = [];
  const moderate = [];

  for (const item of curated.items ?? []) {
    const assignment = (item.projects ?? []).find(
      (entry) => entry.projectKey === project.key || entry.project === project.name
    );
    if (!assignment) continue;

    if (assignment.usefulness === "HIGH") {
      high.push(buildDigestEntry(item, assignment));
    } else if (assignment.usefulness === "MODERATE") {
      moderate.push(buildDigestEntry(item, assignment));
    }
  }
  return { high, moderate };
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
    if (project.summary) lines.push(`Summary: ${project.summary}`);
    lines.push("");

    if (project.high.length) {
      lines.push("## High Usefulness");
      for (const entry of project.high) lines.push(formatEntry(entry));
      lines.push("");
    }

    if (project.moderate.length) {
      lines.push("## Moderate Usefulness");
      for (const entry of project.moderate) lines.push(formatEntry(entry));
      lines.push("");
    }

    if (project.changelog.length) {
      lines.push("## Recent Changelog Notes");
      for (const note of project.changelog.slice(0, 5)) lines.push(`- ${note}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function formatEntry(entry) {
  const lines = [];
  lines.push(`- **${entry.title}** (${entry.usefulness})`);
  if (entry.url) lines.push(`  URL: ${entry.url}`);
  if (entry.summary) lines.push(`  Summary: ${entry.summary}`);
  if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
  if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
  if (entry.publishedAt) lines.push(`  Published: ${entry.publishedAt}`);
  lines.push("  Source: " + entry.sourceType);
  return lines.join("\n");
}

function renderHtmlDigest(payload) {
  const date = new Date(payload.generatedAt).toLocaleString("en-US", {
    timeZone: "America/Toronto",
    dateStyle: "long",
    timeStyle: "short"
  });

  const projectSections = payload.projects
    .map(
      (project) => `
        <h2 style="font-size:18px; font-weight:400; text-decoration:underline; margin:20px 0 12px; color:#111827; font-family: 'Open Sans', Verdana, sans-serif;">${project.name}</h2>
        ${project.high
          .map(
            (entry) => `
            <div style="background:#f9fdfb; border-radius:8px; padding:12px; margin-bottom:16px;">
              <h3 style="font-size:16px; font-weight:500; color:#065f46; margin:0 0 8px; font-family: 'Open Sans', Verdana, sans-serif;">High Usefulness</h3>
              <p style="margin:4px 0; font-size:15px; font-weight:500; font-family: 'Open Sans', Verdana, sans-serif;">${entry.title}</p>
              <p style="font-size:14px; color:#374151; margin:4px 0; line-height:1.5;">${entry.summary}</p>
              <p style="font-size:14px; color:#065f46; margin:4px 0; line-height:1.5;"><em>Why it matters:</em> ${entry.reason}</p>
              ${entry.url ? `<a href="${entry.url}" style="color:#2563eb; font-size:14px;">Go to source</a>` : ""}
            </div>`
          )
          .join("")}
        ${project.moderate
          .map(
            (entry) => `
            <div style="background:#fbfaff; border-radius:8px; padding:12px; margin-bottom:16px;">
              <h3 style="font-size:16px; font-weight:500; color:#5b21b6; margin:0 0 8px; font-family: 'Open Sans', Verdana, sans-serif;">Moderate Usefulness</h3>
              <p style="margin:4px 0; font-size:15px; font-weight:500; font-family: 'Open Sans', Verdana, sans-serif;">${entry.title}</p>
              <p style="font-size:14px; color:#374151; margin:4px 0; line-height:1.5;">${entry.summary}</p>
              <p style="font-size:14px; color:#5b21b6; margin:4px 0; line-height:1.5;"><em>Why it matters:</em> ${entry.reason}</p>
              ${entry.url ? `<a href="${entry.url}" style="color:#2563eb; font-size:14px;">Go to source</a>` : ""}
            </div>`
          )
          .join("")}
        <hr style="border:none; border-top:1px solid #e5e7eb; margin:20px 0;" />
      `
    )
    .join("");

  return `<!DOCTYPE html>
  <html>
    <head><meta charset="utf-8" /></head>
    <body style="font-family: 'Inter','Helvetica Neue',Arial,sans-serif; background:#f9fafb; margin:0; padding:0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="padding:20px;">
        <tr><td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#fff; border-radius:12px; padding:24px; text-align:left;">
            <tr><td>
              <h1 style="color:#111827; font-size:20px; font-weight:400; margin:0 0 12px; font-family: 'Open Sans', Verdana, sans-serif;">Daily Digest</h1>
              <p style="color:#6b7280; font-size:14px; margin:0 0 24px;">Generated at: ${date}</p>
              ${projectSections}
              <p style="text-align:center; margin:0; font-size:14px; color:#374151;">
                You can still browse all recent updates, even those not flagged as useful:<br/>
                <a href="https://your-kb-site.com/digests/" style="color:#2563eb;">View digests on KB-site</a>
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
  </html>`;
}

async function sendBrevoEmail({ subject, textContent, htmlContent, recipients }) {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: recipients.map((email) => ({ email })),
        subject,
        textContent,
        htmlContent
      })
    });
    if (!response.ok) throw new Error(`Brevo error: ${response.status} ${await response.text()}`);
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
      if (content) return { dayDir, stampDir, itemsPath, content };
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
      .split(/\\r?\\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
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
