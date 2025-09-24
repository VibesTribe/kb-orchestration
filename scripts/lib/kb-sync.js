// scripts/lib/kb-sync.js
// Centralized helper to push pipeline updates upstream to VibesTribe/knowledgebase
// Requires ACTIONS_PAT or GITHUB_TOKEN with repo write access

import { upsertFile } from "./github-secrets.js";
import path from "node:path";

const REPO_FILE = "knowledge.json";

/**
 * Push updated knowledgebase snapshot upstream
 * @param {object} knowledge JSON object (must contain {items: []})
 * @param {string} reason Commit message context
 */
export async function pushUpdate(knowledge, reason = "Pipeline update") {
  if (!knowledge || typeof knowledge !== "object") {
    console.warn("pushUpdate called with no knowledge payload");
    return;
  }
  try {
    const body = JSON.stringify(knowledge, null, 2);
    await upsertFile(REPO_FILE, body, reason);
    console.log(`[${new Date().toISOString()}] 🔼 Pushed knowledgebase update (${reason})`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ pushUpdate failed`, { error: err.message });
  }
}
