/**
 * Terminalden arama — UI'i acmadan retrieval kalitesini kontrol etmek icin.
 *
 *   npm run search -- "guvenlik kamerasi ile ses kaydi"
 *   npm run search -- "fidye yazilimi veri ihlali" --limit 5 --year-gte 2023
 */
import { queryClient } from "../src/db/client";
import { hybridSearch } from "../src/search/hybrid";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const query = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
  if (!query) {
    console.error('Kullanim: npm run search -- "sorgu metni" [--limit 5] [--year-gte 2023]');
    process.exit(1);
  }

  const limit = Number(arg("limit") ?? 8);
  const yearGte = arg("year-gte") ? Number(arg("year-gte")) : undefined;
  const yearLte = arg("year-lte") ? Number(arg("year-lte")) : undefined;

  const res = await hybridSearch(query, limit, { yearGte, yearLte });

  console.log(`\nSorgu: "${res.query}"`);
  console.log(
    `Aday: ${res.counts.vector} vektor + ${res.counts.keyword} terim ` +
      `-> ${res.counts.fused} karar | embed ${res.timings.embedMs}ms, ` +
      `retrieval ${res.timings.retrieveMs}ms\n`
  );

  if (res.hits.length === 0) {
    console.log("Sonuc yok.\n");
  }

  res.hits.forEach((h, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. [${h.score.toFixed(5)}] ${(h.kararNo ?? "no'suz").padEnd(10)}` +
        ` ${h.kararTarihi ?? "----------"}  (${h.via.join("+")}, ${h.matchedChunks} chunk)`
    );
    console.log(`    ${(h.konuOzeti ?? h.title).slice(0, 150)}`);
    const passage = (h.highlighted ?? h.snippet).replace(/<\/?mark>/g, "**");
    console.log(`    ${passage.replace(/\s+/g, " ").slice(0, 240)}...`);
    console.log(`    ${h.url}\n`);
  });

  await queryClient.end();
}

main().catch(async (err) => {
  console.error("\nArama basarisiz:", err);
  await queryClient.end().catch(() => {});
  process.exit(1);
});
