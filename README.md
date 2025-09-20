# kb-orchestration

Automation workflows for collecting research inputs, enriching them with AI, scoring usefulness, and publishing curated
knowledge artifacts consumed by [`kb-site`](https://github.com/VibesTribe/kb-site).

## Repository layout

```
.github/workflows/        # GitHub Actions that run the pipeline
config/.env.example       # Template of environment variables required locally
config/sources.json       # Raindrop collections, YouTube playlists/channels, RSS feeds to ingest
projects/                 # Project profiles (metadata, PRD, changelog)
scripts/                  # Node-based orchestration steps (ingest ? publish)
docs/                     # Design notes and operational guides
data/                     # Generated runtime data (ignored in git)
```

Runtime data (e.g., `data/raw`, `data/enriched`, `data/curated`) is ignored via `.gitignore` so that runs remain idempotent
without polluting git history.

## Getting started

```bash
npm install
npm run pipeline # executes ingest ? enrich ? classify ? publish locally
```

Copy `config/.env.example` to `.env` (ignored by git) and populate secrets such as `RAINDROP_TOKEN`, `YOUTUBE_API_KEY`,
`OPENROUTER_API_KEY`, `BREVO_API_KEY`, and `KNOWLEDGEBASE_TOKEN` when running locally. Update `config/sources.json` with
your collection IDs, playlists, channel IDs or @handles (handles are resolved automatically), and feed URLs.

Project configuration lives under `projects/<project>/`. Each project has a `project.json` (metadata, usefulness rubric,
status), a `prd.md` (canonical PRD text), and optionally a `changelog.md`. Set `status` to `active`, `paused`, or
`shelved` to control whether the project participates in classification.

## Pipeline stages

1. **Ingest** – pull Raindrop bookmarks, RSS feeds, and YouTube updates into a raw queue.
2. **Enrich** – normalise data, call OpenRouter (or fallback) to generate summaries, cache them in
   `data/cache/summaries.json`, and write `data/enriched/<date>/<timestamp>/items.json`.
3. **Classify** – load project profiles & PRDs, evaluate usefulness (High/Moderate/Archive) with OpenRouter fallback, and write `data/curated/<date>/<timestamp>/items.json`.
   and write curated results to `data/curated/<date>/<timestamp>/items.json`.
4. **Publish** – update the [`VibesTribe/knowledgebase`](https://github.com/VibesTribe/knowledgebase) repo with curated
   JSON and graph outputs; optionally trigger Brevo digest builds.
5. **Digest** – send the daily briefing email (once classification outputs are ready for consumption).

See [`docs/pipeline.md`](docs/pipeline.md) and [`docs/roadmap.txt`](docs/roadmap.txt) for more detail.

## GitHub Actions

The workflow (`.github/workflows/pipeline.yml`) runs on schedule (03:00 & 13:00 UTC) and can also be triggered manually.
It installs dependencies, executes `npm run pipeline`, and will eventually commit artifacts to the knowledgebase
repository once the publish step is implemented.

### Required secrets

- `RAINDROP_TOKEN` – Raindrop access token (refreshed before expiry)
- `YOUTUBE_API_KEY` – YouTube Data API key for playlist fetching and handle resolution
- `OPENROUTER_API_KEY` – Model access for enrichment and classification (set `OPENROUTER_MODEL` if you prefer another model)
- `BREVO_API_KEY` – Email digest delivery
- `KNOWLEDGEBASE_TOKEN` – Fine-grained PAT or deploy key with push rights to the knowledgebase repo

---

## Project profiles

- `projects/vibeflow/project.json` – metadata, status, usefulness rubric, prompt hints
- `projects/vibeflow/prd.md` – canonical PRD consumed by classification
- `projects/vibeflow/changelog.md` – optional timeline of updates

Duplicate the folder for new projects and adjust fields accordingly. Classification automatically reloads the latest
project files each run.

Enrichment output is written to `data/enriched/<date>/<timestamp>/items.json` and summaries are cached in
`data/cache/summaries.json` to avoid re-sending unchanged items to OpenRouter.
\n\n### OpenRouter model fallback\n- Set `OPENROUTER_MODEL` for your preferred model\n- Optionally set `OPENROUTER_MODEL_CHAIN` (comma-separated) for additional fallbacks\n- Defaults to: xai/grok-4-f ? deepseek/deepseek-v3.1 ? nvidia/nemotron-nano-9b-v2 ? mistralai/mistral-7b-instruct\n

