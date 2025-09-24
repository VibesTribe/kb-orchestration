import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./openrouter.js"; // 🔹 add this

/* ------------------ Utilities ------------------ */
async function ensureDir(dirPath) { await fs.mkdir(dirPath, { recursive: true }); }
async function saveJsonCheckpoint(filePath, data) { await ensureDir(path.dirname(filePath)); await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8"); }
async function saveTextCheckpoint(filePath, text) { await ensureDir(path.dirname(filePath)); await fs.writeFile(filePath, text, "utf8"); }
async function saveHtmlCheckpoint(filePath, html) { await ensureDir(path.dirname(filePath)); await fs.writeFile(filePath, html, "utf8"); }
async function loadJson(filePath, fallback) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; } }
async function listDirectories(parent) { try { const entries = await fs.readdir(parent, { withFileTypes: true }); return entries.filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
function log(message, context = {}) { const ts = new Date().toISOString(); const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : ""; console.log(`[${ts}] ${message}${payload}`); }

/* ------------------ Paths ------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURATED_ROOT = path.join(ROOT_DIR, "data", "curated");
const DIGEST_ROOT = path.join(ROOT_DIR, "data", "digest");
const PROJECTS_ROOT = path.join(ROOT_DIR, "projects");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "no-reply@example.com";
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME ?? "Knowledgebase";
const BREVO_TO = process.env.BREVO_TO ?? "";

/* ------------------ Main digest step ------------------ */
export async function digest() {
  const curatedRun = await getLatestRun(CURATED_ROOT);
  if (!curatedRun) {
    log("No curated data found; skip digest");
    return;
  }

  const projects = await loadProjects();
  const activeProjects = projects.filter((p) => p.status === "active");
  const projectMap = new Map(activeProjects.map((p) => [p.key, p]));

  const digestDir = path.join(DIGEST_ROOT, curatedRun.dayDir, curatedRun.stampDir);
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

    const { high, moderate } = collectItemsForProject(curatedRun.content, project);
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

  /* 🔹 Fallback if no projects produced */
  if (!digestPayload.projects.length) {
    const { content } = await callOpenRouter(
      [
        { role: "system", content: "You are a motivational assistant." },
        { role: "user", content: "Write a short reassuring daily digest note for developers when no new items are available. Keep it under 50 words." }
      ],
      { maxTokens: 100 }
    );
    digestPayload.subject = "Daily Digest – No new updates today";
    digestPayload.projects.push({
      key: "none",
      name: "General Note",
      summary: content,
      high: [],
      moderate: [],
      changelog: [],
    });

    await saveJsonCheckpoint(jsonPath, digestPayload);
    await saveTextCheckpoint(textPath, renderTextDigest(digestPayload));
    await saveHtmlCheckpoint(htmlPath, renderHtmlDigest(digestPayload));
    log("Generated fallback digest note", { content });
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

  await sendBrevoEmail({
    subject: digestPayload.subject,
    textContent: renderTextDigest(digestPayload),
    htmlContent: renderHtmlDigest(digestPayload),
    recipients,
  });
}
