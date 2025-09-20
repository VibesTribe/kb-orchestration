# kb-orchestration

Automation workflows for collecting research inputs, enriching them with AI, scoring usefulness, and publishing curated
knowledge artifacts consumed by [`kb-site`](https://github.com/VibesTribe/kb-site).

## Repository layout

```
.github/workflows/        # GitHub Actions that run the pipeline
config/.env.example       # Template of environment variables required locally
config/sources.json       # List of Raindrop collections, YouTube playlists, RSS feeds to ingest
scripts/                  # Node-based orchestration steps (ingest ? publish)
docs/                     # Design notes and operational guides
```

Runtime data (e.g., `data/raw`, `data/enriched`) is ignored via `.gitignore` so that runs remain idempotent without
polluting git history.

## Getting started

```bash
npm install
npm run pipeline # executes the placeholder pipeline locally
```

Copy `config/.env.example` to `.env`
and update `config/sources.json` with your collection IDs, playlists, and feed URLs (not tracked) and populate secrets such as `RAINDROP_TOKEN`, `GEMINI_API_KEY`,
and `KNOWLEDGEBASE_REPO` when real implementations are added.

## Planned pipeline stages

1. **Ingest** – pull Raindrop bookmarks, RSS feeds, and other inputs into a raw queue.
2. **Enrich** – call low-cost models (Gemini 1.5 Flash, OSS options) to summarise, embed, and tag items.
3. **Classify** – score project relevance & usefulness (High / Moderate / Archive).
4. **Publish** – update the [`VibesTribe/knowledgebase`](https://github.com/VibesTribe/knowledgebase) repo with curated
   JSON and graph outputs; optionally trigger Brevo digest builds.

See [`docs/pipeline.md`](docs/pipeline.md) for more detail.

## GitHub Actions

The starter workflow (`.github/workflows/pipeline.yml`) runs on schedule and manual dispatch. It installs dependencies,
executes `npm run pipeline`, and will eventually commit artifacts to the knowledgebase repository once the publish step
is implemented.

Secrets required by the workflow will include (names subject to change):

- `RAINDROP_TOKEN` – Raindrop API key
- `GEMINI_API_KEY` – Google AI Studio key used for summarisation / embeddings
- `BREVO_API_KEY` – Email digest delivery
- `KNOWLEDGEBASE_TOKEN` – fine-grained PAT or deploy key with push rights to the knowledgebase repo

---

This skeleton keeps the repo ready for incremental development: implement each script, wire tests/linting, then expand
the workflow with caching, notifications, and failure alerts.

