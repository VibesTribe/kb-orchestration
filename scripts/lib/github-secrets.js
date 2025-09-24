// scripts/lib/github-secrets.js
// Create/Update repo secrets via GitHub REST using public key + tweetsodium.

import { Buffer } from "node:buffer";
import sodium from "tweetsodium";

const owner = process.env.GITHUB_REPOSITORY?.split("/")[0];
const repo  = process.env.GITHUB_REPOSITORY?.split("/")[1];

// Prefer ACTIONS_PAT; fall back to the runner's GITHUB_TOKEN if present.
const githubToken = process.env.ACTIONS_PAT || process.env.GITHUB_TOKEN;

if (!owner || !repo) throw new Error("GITHUB_REPOSITORY env is required (owner/repo)");
if (!githubToken)  throw new Error("ACTIONS_PAT or GITHUB_TOKEN is required to update secrets");

async function getPublicKey() {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "kb-orchestration"
    }
  });
  if (!res.ok) throw new Error(`Failed to load public key: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { key_id: json.key_id, key: json.key };
}

function encryptSecret(secretValue, base64PublicKey) {
  const messageBytes = Buffer.from(secretValue);
  const keyBytes = Buffer.from(base64PublicKey, "base64");
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}

export async function setRepoSecret(name, value) {
  const { key_id, key } = await getPublicKey();
  const encrypted_value = encryptSecret(value, key);

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "kb-orchestration"
      },
      body: JSON.stringify({ encrypted_value, key_id })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to set secret ${name}: ${res.status} ${text}`);
  }
}
