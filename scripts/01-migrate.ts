/**
 * drizzle/*.sql dosyalarini DIRECT_URL (5432) uzerinden sirayla kosar.
 *
 * Neden drizzle-kit degil: sema pgvector operator class'i, GENERATED tsvector
 * kolonu ve ozel bir text search konfigurasyonu iceriyor. drizzle-kit push
 * bunlari ya dusurur ya da her kosuda yeniden uretmeye calisir. SQL'i elde
 * tutmak burada daha ongorulebilir.
 *
 *   npm run db:migrate
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HF_EMBEDDING_DIM } from "../src/config";
import { directClient } from "../src/db/direct";

const MIGRATIONS_DIR = join(process.cwd(), "drizzle");

async function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) throw new Error(`drizzle/ altinda .sql bulunamadi`);

  const sql = directClient();
  try {
    // Supabase eklentileri `extensions` semasinda tutuyor; unaccent sozlugunun
    // ALTER MAPPING sirasinda cozulebilmesi icin search_path'e ekliyoruz.
    await sql.unsafe(`SET search_path TO public, extensions`);

    for (const file of files) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const ddl = raw.replaceAll("__DIM__", String(HF_EMBEDDING_DIM));
      process.stdout.write(`  ${file} ... `);
      await sql.unsafe(ddl);
      console.log("ok");
    }

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'kvkk' ORDER BY table_name
    `;
    console.log(`\nkvkk semasi: ${tables.map((t) => t.table_name).join(", ")}`);
    console.log(`embedding boyutu: ${HF_EMBEDDING_DIM}`);
    console.log("\nSirada: npm run scrape\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("\nMigration basarisiz:", err);
  process.exit(1);
});
