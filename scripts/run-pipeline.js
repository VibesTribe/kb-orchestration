// scripts/run-pipeline.js
// Orchestrates the full incremental knowledge pipeline:
// ingest → enrich → classify → digest → publish → sync upstream

import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
import { digest } from "./digest.js";
import { publish } from "./publish.js";
import { syncKnowledge, syncCuratedRun } from "./lib/kb-sync.js"; // ✅ fixed imports

async function run() {
  console.log("🚀 Starting knowledge pipeline...");

  try {
    // 1. Ingest new items
    console.log("📥 Ingesting...");
    await ingest();

    // 2. Enrich with summaries/descriptions
    console.log("✨ Enriching...");
    await enrich();

    // 3. Classify items against active projects
    console.log("🏷️ Classifying...");
    await classify();

    // 4. Generate daily digest (json, txt, html)
    console.log("📰 Building digest...");
    await digest();

    // 5. Publish local artifacts
    console.log("📤 Publishing...");
    await publish();

    // 6. Push knowledge.json upstream
    console.log("⬆️ Syncing knowledge.json...");
    await syncKnowledge();

    // 7. (Optional) Push curated runs upstream
    // Uncomment if you want kb-site to consume curated directly
    // console.log("⬆️ Syncing curated runs...");
    // await syncCuratedRun("data/curated/latest");

    console.log("✅ Pipeline completed successfully!");
  } catch (err) {
    console.error("❌ Pipeline failed:", err);
    process.exit(1);
  }
}

run();
