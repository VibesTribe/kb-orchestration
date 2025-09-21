# kb-orchestration

Automation workflows for collecting research signals, enriching them with AI, scoring usefulness, and publishing curated
artifacts consumed by [`kb-site`](https://github.com/VibesTribe/kb-site).

## Repository layout

```
.github/workflows/        # GitHub Actions that run the pipeline
config/.env.example       # Template of environment variables required locally
config/sources.json       # Raindrop collections, YouTube playlists/channels, RSS feeds to ingest
projects/                 # Project profiles (metadata, PRD, changelog)
scripts/                  # Node-based orchestration steps (ingest ? digest)
docs/                     # Design notes and operational guides
data/                     # Generated runtime data (ignored in git)
```

Runtime data (e.g., `data/raw`, `data/enriched`, `data/curated`, `data/publish`, `data/digest`) is ignored via `.gitignore`
so runs remain idempotent without polluting git history.

## Getting started

```bash
npm install
npm run pipeline # executes ingest ? enrich ? classify ? publish ? digest locally
```

Copy `config/.env.example` to `.env` (ignored by git) and populate secrets such as `RAINDROP_TOKEN`, `YOUTUBE_API_KEY`,
`OPENROUTER_API_KEY`, `BREVO_API_KEY`, and `KNOWLEDGEBASE_TOKEN` when testing locally. Update `config/sources.json` with
your collection IDs, playlists, channel IDs or @handles (handles are resolved automatically), and feed URLs.

Project configuration lives under `projects/<project>/`. Each project has a `project.json` (metadata, usefulness rubric,
status), a `prd.md` (canonical PRD), and optionally a `changelog.md`. Set `status` to `active`, `paused`, or `shelved` to
control whether the project participates in classification.

## Pipeline stages

1. **Ingest** – pull Raindrop bookmarks, RSS feeds, and YouTube updates into a raw queue.
2. **Enrich** – normalise data, call OpenRouter (with automatic model fallback) to generate summaries, cache them in
   `data/cache/summaries.json`, and write `data/enriched/<date>/<timestamp>/items.json`.
3. **Classify** – load project profiles & PRDs, evaluate usefulness (High/Moderate/Archive) via OpenRouter or heuristics,
   and write `data/curated/<date>/<timestamp>/items.json`.
4. **Publish** – build `knowledge.json` and `knowledge.graph.json`, push to
   [`VibesTribe/knowledgebase`](https://github.com/VibesTribe/knowledgebase), and archive copies under `data/publish/`.
5. **Digest** – compile High/Moderate items per project, include changelog highlights, write text/JSON payloads under
   `data/digest/`, and (optionally) send the daily Brevo email.

See [`docs/pipeline.md`](docs/pipeline.md) and [`docs/roadmap.txt`](docs/roadmap.txt) for details and current status.

## GitHub Actions

- `.github/workflows/pipeline.yml` runs on schedule (03:00 & 13:00 UTC) and on manual dispatch.
- `.github/workflows/refresh-raindrop.yml` refreshes the Raindrop access token every 10 days (and on demand).

Both workflows rely on the repository’s `GITHUB_TOKEN` for internal API calls.

### Required secrets

| Secret | Purpose |
| --- | --- |
| `RAINDROP_TOKEN` | Short-lived access token used by ingest (refreshed automatically). |
| `RAINDROP_CLIENT_ID` / `RAINDROP_CLIENT_SECRET` / `RAINDROP_REFRESH_TOKEN` | Long-lived OAuth credentials for the refresh job. |
| `YOUTUBE_API_KEY` | YouTube Data API key (playlists + handle resolution). |
| `OPENROUTER_API_KEY` | Model access for enrichment/classification (`OPENROUTER_MODEL` / `OPENROUTER_MODEL_CHAIN` optionally override fallbacks). |
| `BREVO_API_KEY` | Brevo SMTP/API key for the daily digest. |
| `BREVO_FROM_EMAIL` / `BREVO_FROM_NAME` | Sender identity for digest emails. |
| `BREVO_TO` | Comma/semicolon/space-separated recipient addresses. |
| `KNOWLEDGEBASE_TOKEN` | Fine-grained PAT or deploy key with push rights to `VibesTribe/knowledgebase`. |

### OpenRouter model fallback

- Set `OPENROUTER_MODEL` for your preferred model.
- Optionally set `OPENROUTER_MODEL_CHAIN` (comma-separated) for additional fallbacks.
- Defaults to: `xai/grok-4-f ? deepseek/deepseek-v3.1 ? nvidia/nemotron-nano-9b-v2 ? mistralai/mistral-7b-instruct`.

### Digest email configuration

- `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`, `BREVO_TO` must be configured for email delivery.
- Without these secrets the digest artifacts are still written locally, but no email is sent.

### Raindrop token refresh

- The refresh workflow runs every 10 days (cron `0 5 */10 * *`).
- Provide `RAINDROP_CLIENT_ID`, `RAINDROP_CLIENT_SECRET`, and `RAINDROP_REFRESH_TOKEN`; the workflow updates the
  `RAINDROP_TOKEN` secret automatically before expiry.
