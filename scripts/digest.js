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
} from "./lib/utils.js";

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
  const payload = Object.keys(context).length
    ? ` ${JSON.stringify(context)}`
    : "";
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

  const digestDir = path.join(
    DIGEST_ROOT,
    curatedRun.dayDir,
    curatedRun.stampDir
  );
  await ensureDir(digestDir);

  const jsonPath = path.join(digestDir, "digest.json");
  const textPath = path.join(digestDir, "digest.txt");

  // Load previous checkpoint if it exists
  const digestPayload = (await loadJson(jsonPath, null)) || {
    generatedAt: new Date().toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: []
  };

  // Process projects incrementally
  for (const [projectKey, project] of projectMap.entries()) {
    if (digestPayload.projects.some((p) => p.key === projectKey)) continue;

    const { high, moderate } = collectItemsForProject(
      curatedRun.content,
      project
    );

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

    digestPayload.subject = `Daily Digest – ${digestPayload.totalHigh} Highly Useful + ${digestPayload.totalModerate} Moderately Useful`;

    // Save checkpoint after each project
    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));

    log("Checkpoint saved", { project: project.name });
  }

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
    htmlContent: renderHtmlDigest(digestPayload),
    textContent: renderTextDigest(digestPayload),
    recipients
  });
}

function collectItemsForProject(curated, project) {
  const high = [];
  const moderate = [];

  for (const item of curated.items ?? []) {
    const assignment = (item.projects ?? []).find(
      (entry) =>
        entry.projectKey === project.key || entry.project === project.name
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

// 🟢 HTML rendering
function renderHtmlDigest(payload) {
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const header = `
    <h1 style="font-size:20px; font-weight:400; font-family: 'Open Sans', Verdana, sans-serif; margin:0 0 4px;">Daily Digest</h1>
    <p style="font-size:14px; color:#6b7280; margin:0 0 16px; font-family:'Inter','Helvetica Neue',Arial,sans-serif;">
      ${dateStr}<br>
      News You Can Use Today:<br>
      ${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful
    </p>
  `;

  const projectSections = payload.projects
    .map((project) => {
      const high = project.high
        .map((entry) => renderHtmlEntry(entry, "HIGHLY USEFUL"))
        .join("");
      const moderate = project.moderate
        .map((entry) => renderHtmlEntry(entry, "MODERATELY USEFUL"))
        .join("");

      const changelog =
        project.changelog.length > 0
          ? `<div style="margin-top:12px;">
               <h4 style="font-size:15px; font-weight:500; margin:8px 0;">Recent Changelog Notes</h4>
               <ul style="margin:4px 0 0 16px; padding:0; color:#374151; font-size:14px; line-height:1.5;">
                 ${project.changelog
                   .map((note) => `<li>${note}</li>`)
                   .join("\n")}
               </ul>
             </div>`
          : "";

      return `
        <h2 style="font-size:18px; font-weight:400; text-decoration:underline; margin:20px 0 8px;">${project.name}</h2>
        <p style="margin:0 0 12px; color:#374151; font-size:14px; line-height:1.5;">${project.summary}</p>
        ${high}${moderate}${changelog}
      `;
    })
    .join('<hr style="border:none; border-top:1px solid #e5e7eb; margin:20px 0;">');

  return `
  <div style="font-family:'Inter','Helvetica Neue',Arial,sans-serif; background:#f9fafb; padding:20px;">
    <div style="max-width:600px; margin:0 auto; background:#fff; border-radius:12px; padding:24px;">
      ${header}
      ${projectSections}
      <hr style="border:none; border-top:1px solid #e5e7eb; margin:20px 0;">
      <p style="font-size:14px; color:#374151; text-align:center;">
        You can still browse all recent updates, even those not flagged as useful:<br>
        <a href="https://vibestribe.github.io/kb-site/" style="color:#2563eb;">View this digest on KB-site</a>
      </p>
    </div>
  </div>
  `;
}

function renderHtmlEntry(entry, label) {
  const color =
    label === "HIGHLY USEFUL" ? "#065f46" : "#5b21b6";
  return `
    <div style="background:#f9fdfb; border-radius:8px; padding:12px; margin-bottom:12px;">
      <h3 style="font-size:16px; font-weight:500; color:${color}; margin:0 0 6px;">${label}</h3>
      <p style="margin:4px 0; font-size:15px; font-weight:500;">${entry.title}</p>
      <p style="margin:4px 0; font-size:14px; color:#374151; line-height:1.5;">${entry.summary}</p>
      ${
        entry.reason
          ? `<p style="margin:4px 0; font-size:14px; color:${color}; line-height:1.5;"><em>Why it matters:</em> ${entry.reason}</p>`
          : ""
      }
      ${
        entry.nextSteps
          ? `<p style="margin:4px 0; font-size:14px; color:${color}; line-height:1.5;"><em>Next steps:</em> ${entry.nextSteps}</p>`
          : ""
      }
      ${
        entry.publishedAt
          ? `<p style="margin:4px 0; font-size:14px; color:#374151;">Published: ${new Date(
              entry.publishedAt
            ).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric"
            })}</p>`
          : ""
      }
      ${
        entry.url
          ? `<a href="${entry.url}" style="color:#2563eb; font-size:14px;">Go to source</a>`
          : ""
      }
    </div>
  `;
}

// 🟢 Plain-text fallback
function renderTextDigest(payload) {
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const lines = [];
  lines.push("Daily Digest");
  lines.push(dateStr);
  lines.push("News You Can Use Today:");
  lines.push(
    `${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`
  );
  lines.push("");

  for (const project of payload.projects) {
    lines.push(project.name);
    if (project.summary) lines.push(project.summary);
    lines.push("");

    if (project.high.length) {
      lines.push("Highly Useful");
      for (const entry of project.high) lines.push(formatTextEntry(entry));
      lines.push("");
    }

    if (project.moderate.length) {
      lines.push("Moderately Useful");
      for (const entry of project.moderate) lines.push(formatTextEntry(entry));
      lines.push("");
    }

    if (project.changelog.length) {
      lines.push("Recent Changelog Notes");
      for (const note of project.changelog) lines.push(`- ${note}`);
      lines.push("");
    }
  }

  lines.push(
    "You can still browse all recent updates, even those not flagged as useful:"
  );
  lines.push("View this digest on KB-site → https://vibestribe.github.io/kb-site/");

  return lines.join("\n");
}

function formatTextEntry(entry) {
  const lines = [];
  lines.push(`- ${entry.title}`);
  if (entry.url) lines.push(`  URL: ${entry.url}`);
  if (entry.summary) lines.push(`  Summary: ${entry.summary}`);
  if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
  if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
  if (entry.publishedAt)
    lines.push(
      `  Published: ${new Date(entry.publishedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })}`
    );
  lines.push(`  Source: ${entry.sourceType}`);
  return lines.join("\n");
}

async function sendBrevoEmail({ subject, htmlContent, textContent, recipients }) {
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
        htmlContent,
        textContent
      })
    });
    if (!response.ok)
      throw new Error(`Brevo error: ${response.status} ${await response.text()}`);
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
      .split(/\r?\n/)
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

