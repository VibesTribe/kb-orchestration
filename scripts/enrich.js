import "dotenv/config";

export async function enrich() {
  console.log("TODO: call enrichment models (e.g., Gemini) to summarise and embed items");
  console.log(
    "Persist intermediate results under ./data/enriched to avoid reprocessing unchanged items."
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enrich().catch((error) => {
    console.error("Enrichment step failed", error);
    process.exitCode = 1;
  });
}
