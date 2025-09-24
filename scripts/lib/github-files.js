// scripts/lib/github-files.js
// Provides helpers to upsert (create or update) files in the knowledgebase repo
// using the GitHub REST API. Requires KNOWLEDGEBASE_TOKEN in secrets.

import fetch from "node-fetch";

const owner = "VibesTribe";
const repo = "knowledgebase";
const token = process.env.KNOWLEDGEBASE_TOKEN;

if (!token) {
  throw new Error("Missing KNOWLEDGEBASE_TOKEN env var");
}

/**
 * Upsert a file into the GitHub repo.
 * Creates or updates file at `path` with `content`.
 */
export async function upsertFile({ path, content, message = "Update file" }) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    path
  )}`;

  // Check if file exists
  const getResp = await fetch(apiUrl, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
  });

  let sha = null;
  if (getResp.ok) {
    const json = await getResp.json();
    if (json && json.sha) sha = json.sha;
  }

  // Prepare payload
  const payload = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch: "main",
    ...(sha ? { sha } : {}),
  };

  // PUT to GitHub
  const putResp = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify(payload),
  });

  if (!putResp.ok) {
    const text = await putResp.text();
    throw new Error(`GitHub upsert failed for ${path}: ${putResp.status} ${text}`);
  }

  const result = await putResp.json();
  console.log(`✅ Upserted ${path} (${sha ? "updated" : "created"})`);
  return result;
}
