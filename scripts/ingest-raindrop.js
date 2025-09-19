import "dotenv/config";

export async function ingestRaindrop() {
  console.log("TODO: fetch latest bookmarks from Raindrop, RSS, and other sources");
  console.log(
    "Use RAINDROP_TOKEN and other secrets from environment variables. Persist raw payloads under ./data/raw."
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestRaindrop().catch((error) => {
    console.error("Ingest step failed", error);
    process.exitCode = 1;
  });
}
