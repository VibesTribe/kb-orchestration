// scripts/refresh-raindrop.js
// Refresh Raindrop OAuth token and update GitHub secret RAINDROP_TOKEN

import { setRepoSecret } from "./lib/github-secrets.js";

const clientId = process.env.RAINDROP_CLIENT_ID;
const clientSecret = process.env.RAINDROP_CLIENT_SECRET;
const refreshToken = process.env.RAINDROP_REFRESH_TOKEN;

if (!clientId || !clientSecret || !refreshToken) {
  console.warn("Missing Raindrop refresh credentials; skipping refresh");
  process.exit(0);
}

async function refresh() {
  const res = await fetch("https://api.raindrop.io/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Raindrop token refresh failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  const newToken = json.access_token;
  if (!newToken) {
    throw new Error("Raindrop response missing access_token");
  }

  await setRepoSecret("RAINDROP_TOKEN", newToken);
  console.log("✅ Raindrop token refreshed and stored");
}

refresh().catch((err) => {
  console.error("Raindrop refresh failed", err);
  process.exitCode = 0; // keep pipeline alive
});
