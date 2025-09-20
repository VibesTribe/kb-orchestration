# Pipeline Overview

This document captures the intended flow for the automation pipeline. Each stage runs inside GitHub Actions and writes
intermediate data to the `data/` tree in this repository (ignored by git).

1. **Ingest**
   - Pull bookmarks from Raindrop (collections defined in `config/sources.json`).
   - Aggregate RSS and YouTube feeds tracked by the team (also configured in `config/sources.json`). Channel handles are resolved to channel IDs once and cached in `data/cache/youtube-handles.json`.
   - Drop raw payloads in `data/raw/YYYY-MM-DD/`. These files let later steps re-run idempotently.

2. **Enrich**
   - Normalise data across sources (Raindrop, YouTube, RSS).
   - Generate summaries via OpenRouter (or fallback heuristic) and cache them in `data/cache/summaries.json`.
   - Save enriched payloads to `data/enriched/<date>/<timestamp>/items.json`.
   - (Future) add embeddings / topic classification.

3. **Classify**
   - Load project profiles from `projects/<project>/project.json` and accompanying `prd.md`.
   - Evaluate usefulness tiers (HIGH / MODERATE / ARCHIVE) per project, capturing reasoning and suggested next steps.
   - Write curated outputs to `data/curated/<date>/<timestamp>/items.json` and cache results in `data/cache/classification.json`.

4. **Publish (In Progress)**
   - Commit `knowledge.json` and `knowledge.graph.json` back to `VibesTribe/knowledgebase`.
   - Optionally open a PR rather than pushing directly.
   - Upload digest-ready data for email notifications.

5. **Digest (In Progress)**
   - Build Brevo-ready summaries from curated data (High/Moderate per project).
   - Include changelog highlights and next steps.
   - Deliver emails to configured recipients (10 AM Waterloo).

The pipeline should remain idempotent: re-running on the same day should not duplicate entries.
   - Format the curated set into a Brevo email payload.
   - Send only when usefulness = Moderate to keep the briefing concise.

The pipeline should remain idempotent: re-running on the same day should not duplicate entries.


