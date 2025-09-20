# Pipeline Overview

This document captures the intended flow for the automation pipeline. Each stage runs inside GitHub Actions and writes
intermediate data to the `data/` tree in this repository (ignored by git).

1. **Ingest**
   - Pull bookmarks from Raindrop (collections defined in `config/sources.json`).
   - Aggregate RSS and YouTube feeds tracked by the team (also configured in `config/sources.json`).
   - Drop raw payloads in `data/raw/YYYY-MM-DD/`. These files let later steps re-run idempotently.

2. **Enrich**
   - Generate summaries and embeddings with a low-cost model (Gemini 1.5 Flash or an OSS runner).
   - Detect topics, subtopics, project relevance hints.
   - Save results to `data/enriched/` with versioned filenames.

3. **Classify**
   - Score each item for usefulness (High / Moderate / Archive).
   - Link items to projects and topics, de-duplicate by canonical URL hash.
   - Produce curated outputs in `data/curated/` including graph node/edge sets.

4. **Publish**
   - Commit `knowledge.json` and `knowledge.graph.json` back to `VibesTribe/knowledgebase`.
   - Optionally open a PR rather than pushing directly.
   - Upload digest-ready data for email notifications.

5. **Digest (optional)**
   - Format the curated set into a Brevo email payload.
   - Send only when usefulness >= Moderate to keep the briefing concise.

The pipeline should remain idempotent: re-running on the same day should not duplicate entries.

