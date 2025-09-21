import { Buffer } from "node:buffer";
import nacl from "tweetnacl";

const owner = process.env.GITHUB_REPOSITORY?.split("/")[0];
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const githubToken = process.env.GITHUB_TOKEN;

if (!owner || !repo) {
  throw new Error("GITHUB_REPOSITORY env is required (owner/repo)");
}

if (!githubToken) {
  throw new Error("GITHUB_TOKEN env is required to update secrets");
}

export async function setRepoSecret(name, value) {
  const { key_id, key } = await getPublicKey();
  const encrypted_value = encryptSecret(value, key);

  const response = await fetch(
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to set secret ${name}: ${response.status} ${text}`);
  }
}

async function getPublicKey() {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "kb-orchestration"
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load public key: ${response.status} ${text}`);
  }

  const json = await response.json();
  return { key_id: json.key_id, key: json.key };
}

function encryptSecret(secretValue, base64PublicKey) {
  const messageBytes = Buffer.from(secretValue);
  const keyBytes = Buffer.from(base64PublicKey, "base64");
  const encrypted = nacl.box.seal(messageBytes, keyBytes);
  return Buffer.from(encrypted).toString("base64");
}

