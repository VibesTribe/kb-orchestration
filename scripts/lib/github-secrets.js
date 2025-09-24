// scripts/lib/github-secrets.js
// Update GitHub repo secrets directly using Actions token
// No sodium / encryption needed since we use fine-grained PAT with repo scope.

const owner = process.env.GITHUB_REPOSITORY?.split("/")[0];
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const githubToken = process.env.GITHUB_TOKEN || process.env.ACTIONS_PAT;

if (!owner || !repo) {
  throw new Error("GITHUB_REPOSITORY env is required (owner/repo)");
}
if (!githubToken) {
  throw new Error("ACTIONS_PAT or GITHUB_TOKEN is required to update secrets");
}

/**
 * Set or update a repository secret (plain value, GitHub encrypts internally)
 */
export async function setRepoSecret(name, value) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(
      name
    )}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "kb-orchestration",
      },
      body: JSON.stringify({
        encrypted_value: value,
        key_id: "ignored", // required key but not validated when using PAT
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to set secret ${name}: ${response.status} ${text}`);
  }
}
