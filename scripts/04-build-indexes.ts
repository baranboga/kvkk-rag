/**
 * HNSW vektor indeksini VERI YUKLENDIKTEN SONRA kurar.
 *
 * Bos tabloda index kurup satirlari sonradan yazmak hem yavas hem daha kotu bir
 * graf uretir; bu yuzden index migration'da degil burada.
 *
 *   npm run db:index
 *   npm run db:index -- --rebuild     (mevcut indeksi dusurup yeniden kur)
 */
import { HF_EMBEDDING_DIM } from "../src/config";
import { directClient } from "../src/db/direct";

// m=16 / ef_construction=64: pgvector varsayilanlari. ~4 bin satirda bu degerler
// tam recall'a cok yakin sonuc veriyor; buyutmenin faydasi olcum gerektirir.
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 64;

async function main() {
  const rebuild = process.argv.includes("--rebuild");
  const sql = directClient();

  try {
    const [{ total, embedded }] = await sql<{ total: string; embedded: string }[]>`
      SELECT count(*)::text AS total,
             count(embedding)::text AS embedded
      FROM kvkk.chunks
    `;
    console.log(`\n${embedded}/${total} chunk embed edilmis.`);
    if (Number(embedded) === 0) {
      throw new Error("Embed edilmis chunk yok. Once: npm run embed");
    }
    if (Number(total) - Number(embedded) > 0) {
      console.log(
        `Uyari: ${Number(total) - Number(embedded)} chunk embedding'siz — bunlar aramaya girmez.`
      );
    }

    if (rebuild) {
      console.log("Mevcut HNSW indeksi dusuruluyor...");
      await sql.unsafe(`DROP INDEX IF EXISTS kvkk.chunks_embedding_hnsw_idx`);
    }

    const exists = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kvkk' AND indexname = 'chunks_embedding_hnsw_idx'
    `;
    if (exists.length) {
      console.log("HNSW indeksi zaten var (--rebuild ile yeniden kurabilirsin).");
    } else {
      console.log(
        `HNSW kuruluyor (dim=${HF_EMBEDDING_DIM}, m=${HNSW_M}, ef_construction=${HNSW_EF_CONSTRUCTION})...`
      );
      const t0 = Date.now();
      // vector_cosine_ops: arama tarafinda <=> (kosinus mesafesi) kullaniyoruz.
      // Operator class ile arama operatorunun eslesmemesi indeksi sessizce
      // devre disi birakir.
      await sql.unsafe(`
        CREATE INDEX chunks_embedding_hnsw_idx
        ON kvkk.chunks USING hnsw (embedding vector_cosine_ops)
        WITH (m = ${HNSW_M}, ef_construction = ${HNSW_EF_CONSTRUCTION})
      `);
      console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    // Planlayici tahminleri veri yuklendikten sonra guncellenmeli.
    console.log("ANALYZE...");
    await sql.unsafe(`ANALYZE kvkk.chunks`);
    await sql.unsafe(`ANALYZE kvkk.decisions`);

    // --- Stop lexeme'ler (vurgulama gurultusunu kesmek icin) ---
    //
    // ts_stat tum tsvector'leri tarar; bu yuzden arama sirasinda degil burada,
    // korpus basina bir kez hesaplaniyor. Esik: chunk'larin %`STOPLEX_DF_PCT`'inden
    // fazlasinda gecen lexeme jenerik sayilir (bkz. drizzle/0002_stoplex.sql).
    const STOPLEX_DF_PCT = 25;
    console.log(`Stop lexeme'ler hesaplaniyor (DF > %${STOPLEX_DF_PCT})...`);
    await sql.unsafe(`TRUNCATE kvkk.stoplex`);
    await sql.unsafe(`
      INSERT INTO kvkk.stoplex (lexeme, ndoc)
      SELECT word, ndoc
      FROM ts_stat('SELECT tsv FROM kvkk.chunks')
      WHERE ndoc > (SELECT count(*) FROM kvkk.chunks) * ${STOPLEX_DF_PCT} / 100.0
      ON CONFLICT (lexeme) DO UPDATE SET ndoc = excluded.ndoc
    `);
    const [stop] = await sql<{ n: string; top: string }[]>`
      SELECT count(*)::text AS n,
             (SELECT string_agg(lexeme, ', ' ORDER BY ndoc DESC)
              FROM (SELECT lexeme, ndoc FROM kvkk.stoplex ORDER BY ndoc DESC LIMIT 6) s
             ) AS top
      FROM kvkk.stoplex
    `;
    console.log(`   ${stop.n} lexeme elendi (en sik: ${stop.top})`);

    const indexes = await sql<{ indexname: string; size: string }[]>`
      SELECT indexname,
             pg_size_pretty(pg_relation_size(('kvkk.' || indexname)::regclass)) AS size
      FROM pg_indexes WHERE schemaname = 'kvkk' ORDER BY indexname
    `;
    console.log("\n=== kvkk semasindaki indeksler ===");
    for (const i of indexes) console.log(`  ${i.indexname.padEnd(34)} ${i.size}`);
    console.log("\nSirada: npm run dev  ->  http://localhost:3000\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("\nIndex kurulumu basarisiz:", err);
  process.exit(1);
});
