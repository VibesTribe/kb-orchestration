// scripts/run-pipeline.js
import { runIngest } from "./ingest.js";
import { runEnrich } from "./enrich.js";
import { runClassify } from "./classify.js";
import { runDigest } from "./digest.js";
import { runPublish } from "./publish.js";

async function main() {
  console.log("🚀 Starting pipeline...");

  try {
    console.log("📥 Step 1: Ingest");
    await runIngest();

    console.log("✨ Step 2: Enrich");
    await runEnrich();

    console.log("🏷️ Step 3: Classify");
    await runClassify();

    console.log("📰 Step 4: Digest");
    await runDigest();

    console.log("📤 Step 5: Publish");
    await runPublish();

    console.log("✅ Pipeline completed successfully!");
  } catch (err) {
    console.error("❌ Pipeline failed:", err);
    process.exit(1);
  }
}

main();
