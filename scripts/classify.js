export async function classify() {
  console.log("TODO: score project relevance & usefulness, apply pruning rules");
  console.log("Write curated list to ./data/curated before publishing");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  classify().catch((error) => {
    console.error("Classification step failed", error);
    process.exitCode = 1;
  });
}
