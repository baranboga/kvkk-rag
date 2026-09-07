/**
 * kvkk semasini tamamen dusurur (tablolar + text search config).
 *
 * Embedding modelini/boyutunu degistirdiysen gerekli: `vector(N)` kolonunun
 * boyutu sema tanimidir, ALTER ile guvenli sekilde degistirilemez.
 *
 * data/decisions.json'a DOKUNMAZ — scrape'i tekrarlamana gerek kalmaz, sadece
 * db:migrate + embed yeterlidir.
 *
 *   npm run db:reset -- --yes
 */
import { directClient } from "../src/db/direct";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "\nBu komut kvkk semasindaki TUM kararlari ve embedding'leri siler.\n" +
        "Eminsen: npm run db:reset -- --yes\n"
    );
    process.exit(1);
  }

  const sql = directClient();
  try {
    const [before] = await sql<{ decisions: string; chunks: string }[]>`
      SELECT
        (SELECT count(*) FROM kvkk.decisions)::text AS decisions,
        (SELECT count(*) FROM kvkk.chunks)::text AS chunks
    `.catch(() => [{ decisions: "0", chunks: "0" }] as never);

    console.log(`\nSiliniyor: ${before.decisions} karar, ${before.chunks} chunk`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS kvkk CASCADE`);
    console.log("kvkk semasi dusuruldu.");
    console.log("\nSirada: npm run db:migrate && npm run embed\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("\nReset basarisiz:", err);
  process.exit(1);
});
