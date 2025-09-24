// scripts/lib/github-secrets.js
// Safe helpers to update repository secrets via GitHub REST API.
// - No top-level throws (so importing this file never crashes your job)
// - Uses ACTIONS_PAT if present; falls back to GITHUB_TOKEN
// - Encrypts values with the repo's public key (tweetsodium)

import fetch from "node-fetch";
import sodium from "tweetsodium"; // yes, deprecated, but matches your existing stack

const REPO_SLUG = process.env.GITHUB_REPOSITORY || ""; // owner/repo
const [DEFAULT_OWNER, DEFAULT_REPO] = REPO_SLUG.split("/");

// --- internal helpers ---
function getAuthToken() {
  return process.env.ACTIONS_PAT || process.env.GITHUB_TOKEN || null;
}

function repoCoords({ owner, repo } = {}) {
  return {
    owner: owner || DEFAULT_OWNER,
    repo: repo || DEFAULT_REPO,
  };
}

async function githubFetch(path, init = {}, coords) {
  const token = getAuthToken();
  if (!token) {
    // Don’t throw here; let caller decide. Return a dummy 401-like response
    return {
      ok: false,
      status: 401,
      text: async () => "Missing ACTIONS_PAT/GITHUB_TOKEN",
      json: async () => ({ message: "Missing ACTIONS_PAT/GITHUB_TOKEN" }),
    };
  }
  const { owner, repo } = repoCoords(coords);
  const url = `https://api.github.com/repos/${owner}/${repo}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`,
      ...(init.headers || {}),
    },
  });
  return res;
}

async function getPublicKey(coords) {
  const res = await githubFetch(`/actions/secrets/public-key`, {}, coords);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch secrets public key (${res.status}): ${body}`);
  }
  return res.json(); // { key_id, key }
}

function encryptWithKey(plainText, base64Key) {
  const messageBytes = Buffer.from(String(plainText));
  const keyBytes = Buffer.from(base64Key, "base64");
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}

export async function updateRepoSecret(name, value, coords) {
  const token = getAuthToken();
  if (!token) {
    console.warn(`[github-secrets] Skipping update for ${name}: no ACTIONS_PAT/GITHUB_TOKEN`);
    return { skipped: true, reason: "no-token" };
  }
  const { key_id, key } = await getPublicKey(coords);
  const encrypted_value = encryptWithKey(value, key);
  const res = await githubFetch(
    `/actions/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: JSON.stringify({ encrypted_value, key_id }),
    },
    coords
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to set secret ${name} (${res.status}): ${body}`);
  }
  console.log(`[github-secrets] ✅ Updated secret: ${name}`);
  return { ok: true };
}

// Bulk update convenience
export async function updateRepoSecrets(secretsObj = {}, coords) {
  const results = {};
  for (const [name, value] of Object.entries(secretsObj)) {
    if (value == null) {
      console.warn(`[github-secrets] Skipping ${name}: value is null/undefined`);
      continue;
    }
    try {
      results[name] = await updateRepoSecret(name, String(value), coords);
    } catch (e) {
      console.error(`[github-secrets] ❌ Failed to update ${name}:`, e.message);
      results[name] = { ok: false, error: e.message };
    }
  }
  return results;
}
