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

    digestPayload.subject = `Daily Digest – ${new Date(
      digestPayload.generatedAt
    ).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    })}`;

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(
      textPath,
      renderTextDigest(digestPayload, curatedRun)
    );

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
    textContent: renderTextDigest(digestPayload, curatedRun),
    htmlContent: renderHtmlDigest(digestPayload, curatedRun),
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
    if (assignment.usefulness === "HIGH")
      high.push(buildDigestEntry(item, assignment));
    else if (assignment.usefulness === "MODERATE")
      moderate.push(buildDigestEntry(item, assignment));
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

/* ---------- Plain Text Digest ---------- */
function renderTextDigest(payload, curatedRun) {
  const lines = [];
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  lines.push(`Daily Digest – ${dateStr}`);
  lines.push("");
  lines.push(
    `News You Can Use Today:\n${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful`
  );
  lines.push("");

  for (const project of payload.projects) {
    lines.push(`Project: ${project.name}`);
    if (project.summary) lines.push(`Summary: ${project.summary}`);
    lines.push("");

    if (project.high.length) {
      lines.push("High Usefulness");
      for (const entry of project.high) lines.push(formatEntry(entry));
      lines.push("");
    }
    if (project.moderate.length) {
      lines.push("Moderate Usefulness");
      for (const entry of project.moderate) lines.push(formatEntry(entry));
      lines.push("");
    }
    if (project.changelog.length) {
      lines.push("Recent Changelog Notes");
      for (const note of project.changelog.slice(0, 5)) lines.push(`- ${note}`);
      lines.push("");
    }
  }

  const digestUrl = `https://your-kb-site.com/digests/${curatedRun.dayDir}/${curatedRun.stampDir}/`;
  lines.push("----------------------------------------");
  lines.push("You can browse all recent updates, even those not flagged as useful:");
  lines.push(`View this digest on KB-site → ${digestUrl}`);

  return lines.join("\n");
}

function formatEntry(entry) {
  const dateStr = entry.publishedAt
    ? new Date(entry.publishedAt).toLocaleString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      })
    : "";
  const lines = [];
  lines.push(`- ${entry.title}`);
  if (entry.url) lines.push(`  URL: ${entry.url}`);
  if (entry.summary) lines.push(`  Summary: ${entry.summary}`);
  if (entry.reason) lines.push(`  Why it matters: ${entry.reason}`);
  if (entry.nextSteps) lines.push(`  Next steps: ${entry.nextSteps}`);
  if (dateStr) lines.push(`  Published: ${dateStr}`);
  lines.push(`  Source: ${entry.sourceType}`);
  return lines.join("\n");
}

/* ---------- HTML Digest ---------- */
function renderHtmlDigest(payload, curatedRun) {
  const dateStr = new Date(payload.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const digestUrl = `https://your-kb-site.com/digests/${curatedRun.dayDir}/${curatedRun.stampDir}/`;

  let html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Daily Digest</title>
  </head>
  <body style="font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f9fafb; padding: 20px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background-color: #ffffff; border-radius: 12px; padding: 24px; text-align: left;">
            <tr>
              <td>
                <h1 style="color: #111827; font-size: 20px; font-weight:400; margin: 0 0 12px; font-family: 'Open Sans', Verdana, sans-serif;">Daily Digest</h1>
                <p style="color: #6b7280; font-size: 14px; margin: 0 0 24px;">${dateStr} — News You Can Use Today: ${payload.totalHigh} Highly Useful + ${payload.totalModerate} Moderately Useful</p>
  `;

  for (const project of payload.projects) {
    html += `
      <h2 style="font-size:18px; font-weight:400; text-decoration:underline; margin:20px 0 12px; color:#111827; font-family: 'Open Sans', Verdana, sans-serif;">${project.name}</h2>
      ${project.summary ? `<p style="font-size:14px; color:#374151; margin:0 0 16px;">${project.summary}</p>` : ""}
    `;

    for (const entry of project.high) {
      html += renderHtmlEntry(entry, "HIGH");
    }
    for (const entry of project.moderate) {
      html += renderHtmlEntry(entry, "MODERATE");
    }

    if (project.changelog.length) {
      html += `<h3 style="font-size:15px; font-weight:500; margin:16px 0 8px;">Recent Changelog Notes</h3>`;
      html += "<ul>";
      for (const note of project.changelog.slice(0, 5)) {
        html += `<li style="font-size:14px; color:#374151;">${note}</li>`;
      }
      html += "</ul>";
    }

    html += `<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />`;
  }

  html += `
                <p style="text-align: center; margin: 0; font-size: 14px; color: #374151;">
                  You can still browse all recent updates, even those not flagged as useful:<br>
                  <a href="${digestUrl}" style="color:#2563eb;">View this digest on KB-site</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
  return html;
}

function renderHtmlEntry(entry, level) {
  const color = level === "HIGH" ? "#065f46" : "#5b21b6";
  const bg = level === "HIGH" ? "#f9fdfb" : "#fbfaff";

  const dateStr = entry.publishedAt
    ? new Date(entry.publishedAt).toLocaleString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      })
    : "";

  return `
    <div style="background:${bg}; border-radius:8px; padding:12px; margin-bottom:16px;">
      <h3 style="font-size:16px; font-weight:500; color:${color}; margin:0 0 8px;">${level} Usefulness</h3>
      <p style="margin:4px 0; font-size:15px; font-weight:500;">${entry.title}</p>
      ${entry.summary ? `<p style="font-size:14px; color:#374151; margin:4px 0; line-height:1.5;">${entry.summary}</p>` : ""}
      ${entry.reason ? `<p style="font-size:14px; color:${color}; margin:4px 0; line-height:1.5;"><em>Why it matters:</em> ${entry.reason}</p>` : ""}
      ${entry.nextSteps ? `<p style="font-size:14px; color:${color}; margin:4px 0; line-height:1.5;"><em>Next steps:</em> ${entry.nextSteps}</p>` : ""}
      ${dateStr ? `<p style="font-size:14px; color:#374151; margin:4px 0;">Published: ${dateStr}</p>` : ""}
      <a href="${entry.url}" style="color:#2563eb; font-size:14px;">Go to source</a>
    </div>
  `;
}

/* ---------- Helpers ---------- */
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
    projects.push({ key: dir, changelog, ...config });
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
