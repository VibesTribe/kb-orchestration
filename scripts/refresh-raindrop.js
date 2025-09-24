// scripts/refresh-raindrop.js
// Refresh Raindrop access token using client creds + refresh token,
// then write new token back to repo secret RAINDROP_TOKEN.

import { setRepoSecret } from "./lib/github-secrets.js";

const clientId     = process.env.RAINDROP_CLIENT_ID;
const clientSecret = process.env.RAINDROP_CLIENT_SECRET;
const refreshToken = process.env.RAINDROP_REFRESH_TOKEN;

if (!clientId || !clientSecret || !refreshToken) {
  console.log("Raindrop refresh skipped (missing client/secret/refresh).");
  process.exit(0);
}

async function refresh() {
  const res = await fetch("https://raindrop.io/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    })
  });

  if (!res.ok) {
    throw new Error(`Raindrop token refresh failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const newAccessToken = json.access_token;
  if (!newAccessToken) throw new Error("No access_token in Raindrop response");

  await setRepoSecret("RAINDROP_TOKEN", newAccessToken);
  console.log("Refreshed Raindrop token and updated repo secret.");
}

refresh().catch((err) => {
  console.error("Raindrop refresh failed", err);
  process.exitCode = 0; // don't fail the whole workflow
});
