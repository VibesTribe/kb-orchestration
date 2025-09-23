// run-pipeline.js
import "dotenv/config";
import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
import { digest } from "./digest.js";
import { publish } from "./publish.js";

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

export async function runPipeline() {
  const steps = [
    { name: "Ingest", fn: ingest },
    { name: "Enrich", fn: enrich },
    { name: "Classify", fn: classify },
    { name: "Digest", fn: digest },
    { name: "Publish", fn: publish }
  ];

  for (const step of steps) {
    logStep(`▶ Starting ${step.name} step`);
    try {
      await step.fn();
      logStep(`✅ Completed ${step.name} step`);
    } catch (error) {
      console.error(`❌ ${step.name} step failed`, error);
      throw error; // exit early if any step fails
    }
  }

  logStep("🎉 Pipeline finished successfully");
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((error) => {
    console.error("Pipeline failed", error);
    process.exitCode = 1;
  });
}
