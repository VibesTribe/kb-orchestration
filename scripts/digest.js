import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadJson,
  saveJsonCheckpoint,
  saveTextCheckpoint,
  saveHtmlCheckpoint,
  ensureDir,
  listDirectories,
} from "../lib/utils.js";

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
  const htmlPath = path.join(digestDir, "digest.html");

  const digestPayload = (await loadJson(jsonPath, null)) || {
    generatedAt: new Date().toISOString(),
    subject: "",
    totalHigh: 0,
    totalModerate: 0,
    projects: [],
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
      changelog: project.changelog ?? [],
    };

    digestPayload.projects.push(projectDigest);
    digestPayload.totalHigh += high.length;
    digestPayload.totalModerate += moderate.length;

    digestPayload.subject = `Daily Digest – ${digestPayload.totalHigh} Highly Useful + ${digestPayload.totalModerate} Moderately Useful`;

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveHtmlCheckpoint(htmlPath, renderHtmlDigest(digestPayload));

    log("Checkpoint saved", { project: project.name });
  }

  log("Digest artifacts prepared", {
    json: path.relative(ROOT_DIR, jsonPath),
    text: path.relative(ROOT_DIR, textPath),
    html: path.relative(ROOT_DIR, htmlPath),
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
    recipients,
  });
}

// --- existing helpers below (collectItemsForProject, renderTextDigest, renderHtmlDigest, etc.) ---
// leave them as-is in your file
