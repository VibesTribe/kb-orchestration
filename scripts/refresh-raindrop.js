import "dotenv/config";
import { setRepoSecret } from "./lib/github-secrets.js";

const clientId = process.env.RAINDROP_CLIENT_ID;
const clientSecret = process.env.RAINDROP_CLIENT_SECRET;
const refreshToken = process.env.RAINDROP_REFRESH_TOKEN;
const targetSecret = process.env.RAINDROP_TARGET_SECRET ?? "RAINDROP_TOKEN";

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

assert(clientId, "RAINDROP_CLIENT_ID env is required");
assert(clientSecret, "RAINDROP_CLIENT_SECRET env is required");
assert(refreshToken, "RAINDROP_REFRESH_TOKEN env is required");

const tokenEndpoint = "https://raindrop.io/oauth/access_token";

async function refresh() {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Raindrop token refresh failed: ${response.status} ${text}`);
  }

  const json = await response.json();
  const accessToken = json.access_token;
  const expiresIn = json.expires_in;
  const expiresAt = json.expires ? new Date(json.expires * 1000).toISOString() : null;

  if (!accessToken) {
    throw new Error("Raindrop response missing access_token");
  }

  await setRepoSecret(targetSecret, accessToken);

  console.log("Refreshed Raindrop token", {
    targetSecret,
    expiresIn,
    expiresAt
  });
}

refresh().catch((error) => {
  console.error("Raindrop refresh failed", error);
  process.exitCode = 1;
});

