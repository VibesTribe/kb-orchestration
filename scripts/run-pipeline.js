import { ingest } from "./ingest.js";
import { enrich } from "./enrich.js";
import { classify } from "./classify.js";
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
    { name: "Publish", fn: publish }
  ];

  for (const step of steps) {
    logStep(`Starting ${step.name} step`);
    await step.fn();
    logStep(`Completed ${step.name} step`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((error) => {
    console.error("Pipeline failed", error);
    process.exitCode = 1;
  });
}

