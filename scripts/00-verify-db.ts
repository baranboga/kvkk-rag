/**
 * Migration'dan ONCE kosulmali: pgvector, HNSW ve Turkce full-text destegi var mi?
 * Bunlar yoksa migration ya patlar ya da sessizce yanlis konfigurasyon uretir.
 *
 *   npm run verify:db
 */
import { HF_EMBEDDING_DIM, HF_EMBEDDING_MODEL } from "../src/config";
import { directClient } from "../src/db/direct";

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;

async function main() {
  const sql = directClient();
  let failures = 0;

  console.log("\n=== KVKK RAG — ortam dogrulamasi ===\n");
  console.log(`Model : ${HF_EMBEDDING_MODEL}`);
  console.log(`Boyut : ${HF_EMBEDDING_DIM}\n`);

  try {
    const [v] = await sql<{ version: string }[]>`SELECT version()`;
    console.log(ok(`Postgres: ${v.version.split(" ").slice(0, 2).join(" ")}`));

    const ext = await sql<{ extversion: string }[]>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'
    `;
    if (ext.length) console.log(ok(`pgvector: ${ext[0].extversion}`));
    else {
      failures++;
      console.log(bad("pgvector kurulu degil (migration CREATE EXTENSION deneyecek)"));
    }

    const hnsw = await sql<{ amname: string }[]>`
      SELECT amname FROM pg_am WHERE amname = 'hnsw'
    `;
    if (hnsw.length) console.log(ok("HNSW index metodu mevcut"));
    else {
      failures++;
      console.log(bad("HNSW yok — pgvector 0.5.0+ gerekiyor"));
    }

    const unaccent = await sql<{ extversion: string }[]>`
      SELECT extversion FROM pg_extension WHERE extname = 'unaccent'
    `;
    console.log(
      unaccent.length
        ? ok(`unaccent: ${unaccent[0].extversion}`)
        : "  · unaccent henuz kurulu degil (migration kuracak)"
    );

    const tr = await sql<{ cfgname: string }[]>`
      SELECT cfgname FROM pg_ts_config WHERE cfgname = 'turkish'
    `;
    if (tr.length) console.log(ok("Turkce full-text konfigurasyonu (turkish) mevcut"));
    else {
      failures++;
      console.log(bad("'turkish' text search konfigurasyonu yok — hybrid arama calismaz"));
    }

    const stem = await sql<{ dictname: string }[]>`
      SELECT dictname FROM pg_ts_dict WHERE dictname = 'turkish_stem'
    `;
    console.log(
      stem.length ? ok("turkish_stem sozlugu mevcut") : bad("turkish_stem sozlugu yok")
    );
    if (!stem.length) failures++;

    // Kurulmus semanin durumu
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'kvkk'
      ORDER BY table_name
    `;
    console.log(
      tables.length
        ? `\n  kvkk semasi: ${tables.map((t) => t.table_name).join(", ")}`
        : "\n  kvkk semasi henuz yok (npm run db:migrate)"
    );

    if (tables.some((t) => t.table_name === "chunks")) {
      const [dims] = await sql<{ dim: number | null }[]>`
        SELECT a.atttypmod AS dim
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kvkk' AND c.relname = 'chunks' AND a.attname = 'embedding'
      `;
      if (dims?.dim && dims.dim !== HF_EMBEDDING_DIM) {
        failures++;
        console.log(
          bad(
            `Tablodaki embedding boyutu ${dims.dim}, .env ise ${HF_EMBEDDING_DIM}. ` +
              `Model degistirdiysen: DROP SCHEMA kvkk CASCADE; sonra db:migrate.`
          )
        );
      }
      const [counts] = await sql<{ decisions: string; chunks: string; embedded: string }[]>`
        SELECT
          (SELECT count(*) FROM kvkk.decisions)::text AS decisions,
          (SELECT count(*) FROM kvkk.chunks)::text AS chunks,
          (SELECT count(*) FROM kvkk.chunks WHERE embedding IS NOT NULL)::text AS embedded
      `;
      console.log(
        `  kayitlar   : ${counts.decisions} karar, ${counts.chunks} chunk, ${counts.embedded} embedding`
      );
    }
  } finally {
    await sql.end();
  }

  console.log(
    failures === 0
      ? "\nSonuc: hazir.\n"
      : `\nSonuc: ${failures} sorun var — yukaridaki ✗ satirlarina bak.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nDogrulama basarisiz:", err);
  process.exit(1);
});
