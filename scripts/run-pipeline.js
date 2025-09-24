// scripts/run-pipeline.js
// Orchestrates the full incremental knowledge pipeline:
// ingest → enrich → classify → digest → publish → sync upstream

import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
import { digest } from "./digest.js";
import { publish } from "./publish.js";
import { syncKnowledge, syncCuratedRun, syncDigest } from "./lib/kb-sync.js";

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

    // 4. Generate daily digest
    console.log("📰 Building digest...");
    const digestResult = await digest();

    // 5. Publish local artifacts
    console.log("📤 Publishing...");
    await publish({ digestResult });

    // 6. Push knowledge.json upstream
    console.log("⬆️ Syncing knowledge.json...");
    await syncKnowledge();

    // 7. (Optional) Push curated/latest upstream
    // console.log("⬆️ Syncing curated run...");
    // await syncCuratedRun("data/curated/latest");

    // 8. (Optional) Push digest artifacts upstream
    if (digestResult) {
      console.log("⬆️ Syncing digest artifacts...");
      await syncDigest(digestResult);
    }

    console.log("✅ Pipeline completed successfully!");
  } catch (err) {
    console.error("❌ Pipeline failed:", err);
    process.exit(1);
  }
}

run();
