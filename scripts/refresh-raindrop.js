// scripts/refresh-raindrop.js
// Refresh Raindrop tokens and write BOTH access + refresh tokens back to repo secrets.
// Non-blocking by default: exit code 0 even on failure (workflow uses "|| true").

import fetch from "node-fetch";
import { updateRepoSecrets } from "./lib/github-secrets.js";

const RAINDROP_CLIENT_ID = process.env.RAINDROP_CLIENT_ID;
const RAINDROP_CLIENT_SECRET = process.env.RAINDROP_CLIENT_SECRET;
const RAINDROP_REFRESH_TOKEN = process.env.RAINDROP_REFRESH_TOKEN;

// Raindrop OAuth refresh endpoint (note: NOT /v1/...)
// Docs use /oauth/access_token
const RAINDROP_TOKEN_URL = "https://raindrop.io/oauth/access_token";

function log(msg, ctx = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

async function refresh() {
  if (!RAINDROP_CLIENT_ID || !RAINDROP_CLIENT_SECRET || !RAINDROP_REFRESH_TOKEN) {
    log("Skipping refresh: missing raindrop OAuth envs");
    return { skipped: true };
  }

  // Request a new access token (and possibly a new refresh token)
  const resp = await fetch(RAINDROP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: RAINDROP_REFRESH_TOKEN,
      client_id: RAINDROP_CLIENT_ID,
      client_secret: RAINDROP_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Raindrop refresh failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  // Expected fields: access_token, token_type, expires_in, refresh_token?
  const access = json.access_token;
  const newRefresh = json.refresh_token || null;

  if (!access) throw new Error("No access_token in refresh response");

  // Update repo secrets. We write both:
  // - RAINDROP_TOKEN          (access token)
  // - RAINDROP_REFRESH_TOKEN  (rotate if provided)
  const secrets = { RAINDROP_TOKEN: access };
  if (newRefresh) secrets.RAINDROP_REFRESH_TOKEN = newRefresh;

  const results = await updateRepoSecrets(secrets);
  log("Raindrop secrets update results", results);
  return { ok: true, rotated: Boolean(newRefresh) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refresh()
    .then((r) => {
      log("Refresh finished", r || {});
      // Non-blocking: always succeed
      process.exitCode = 0;
    })
    .catch((e) => {
      log("Refresh error", { error: e.message });
      // Non-blocking: always succeed
      process.exitCode = 0;
    });
}

export { refresh };
