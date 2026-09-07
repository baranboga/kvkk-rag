/**
 * data/decisions.json -> Postgres (kararlar + chunk'lar) -> HF embedding.
 *
 * Yeniden kosulabilir ve kaldigi yerden devam eder: yalnizca `embedding IS NULL`
 * olan chunk'lar embed edilir. HF rate limit'e girip kosu yarida kalirsa scripti
 * tekrar calistirmak yeter.
 *
 *   npm run embed
 *   npm run embed -- --limit 50        (ilk 50 karar — hizli deneme)
 *   npm run embed -- --concurrency 3
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBED_BATCH_SIZE, HF_EMBEDDING_MODEL } from "../src/config";
import { chunkText } from "../src/chunk";
import { queryClient } from "../src/db/client";
import { extractRuling, extractSanction } from "../src/extract";
import { embedPassages, toVectorLiteral } from "../src/embeddings/hf";
import type { ScrapedDecision } from "../src/scrape/kvkk";

const INPUT = join(process.cwd(), "data", "decisions.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Chunk'lara denormalize edilen baglam basligi.
 *
 * Karar govdesi "veri sorumlusu", "ilgili kisi" gibi genel ifadelerle yazilmis;
 * hangi sektor/olay oldugu cogu zaman yalnizca baslikta geciyor. Baslik olmadan
 * "hastane kayitlari" gibi bir sorgu dogru karari bulamiyor.
 *
 * `head` embedding girdisine ve tsvector'e girer; UI'da gosterilen pasaj ise
 * yalnizca `text` (bkz. drizzle/0000_init.sql).
 */
function headOf(d: ScrapedDecision): string {
  return (d.konuOzeti?.trim() || d.title).replace(/\s+/g, " ").trim();
}

/** HF'e gonderilen metin: baglam basligi + pasaj. */
function embedInput(head: string, text: string): string {
  return head ? `${head}\n\n${text}` : text;
}

/** Diziyi `size` uzunlugunda parcalara boler. */
function batched<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  if (!existsSync(INPUT)) {
    throw new Error(`${INPUT} yok. Once: npm run scrape`);
  }

  const limit = Number(arg("limit") ?? 0);
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 2));

  let decisions: ScrapedDecision[] = JSON.parse(readFileSync(INPUT, "utf8"));
  if (limit > 0) decisions = decisions.slice(0, limit);
  console.log(`\n${decisions.length} karar okundu. Model: ${HF_EMBEDDING_MODEL}\n`);

  // Satir basina bir INSERT gonderilmesi burada gercek bir maliyet: DB uzak
  // (Supabase pooler) ve ~2500 chunk demek ~2500 round-trip. Cok satirli
  // INSERT ile tek istekte DB_BATCH satir yaziyoruz.
  const DB_BATCH = 200;

  // --- 1) Kararlari yaz ---
  console.log("1) Kararlar yaziliyor...");
  const decisionRows = decisions.map((d) => {
    // Hukum + yaptirim: govdeden deterministik cikarim, API cagrisi yok.
    const sanction = extractSanction(d.body);
    return {
      id: d.id,
      source: d.source,
      karar_no: d.kararNo,
      karar_tarihi: d.kararTarihi,
      year: d.year,
      title: d.title,
      konu_ozeti: d.konuOzeti,
      meta: JSON.stringify(d.meta),
      body: d.body,
      url: d.url,
      char_count: d.charCount,
      ruling: extractRuling(d.body),
      sanction_label: sanction?.label ?? null,
      sanction_kind: sanction?.kind ?? null,
      sanction_amount_try: sanction?.amountTry ?? null,
    };
  });

  for (const batch of batched(decisionRows, DB_BATCH)) {
    await queryClient`
      INSERT INTO kvkk.decisions ${queryClient(batch)}
      ON CONFLICT (id) DO UPDATE SET
        source = excluded.source,
        karar_no = excluded.karar_no,
        karar_tarihi = excluded.karar_tarihi,
        year = excluded.year,
        title = excluded.title,
        konu_ozeti = excluded.konu_ozeti,
        meta = excluded.meta,
        body = excluded.body,
        url = excluded.url,
        char_count = excluded.char_count,
        ruling = excluded.ruling,
        sanction_label = excluded.sanction_label,
        sanction_kind = excluded.sanction_kind,
        sanction_amount_try = excluded.sanction_amount_try,
        scraped_at = now()
    `;
  }
  console.log(`   ${decisions.length} karar yazildi.\n`);

  // --- 2) Chunk'lari yaz ---
  console.log("2) Chunk'lar uretiliyor...");
  const chunkRows = decisions.flatMap((d) => {
    const head = headOf(d);
    return chunkText(d.body).map((c) => ({
      id: `${d.id}#${c.index}`,
      decision_id: d.id,
      chunk_index: c.index,
      head,
      text: c.text,
      token_estimate: c.tokenEstimate,
    }));
  });

  for (const batch of batched(chunkRows, DB_BATCH)) {
    await queryClient`
      INSERT INTO kvkk.chunks ${queryClient(batch)}
      ON CONFLICT (id) DO UPDATE SET
        head = excluded.head,
        text = excluded.text,
        token_estimate = excluded.token_estimate,
        -- Embedding girdisi head+text; ikisinden biri degistiyse eski vektor
        -- gecersiz: NULL'a cek, sonraki adimda yeniden embed edilsin.
        embedding = CASE
          WHEN kvkk.chunks.text = excluded.text AND kvkk.chunks.head = excluded.head
          THEN kvkk.chunks.embedding ELSE NULL END,
        embedded_at = CASE
          WHEN kvkk.chunks.text = excluded.text AND kvkk.chunks.head = excluded.head
          THEN kvkk.chunks.embedded_at ELSE NULL END
    `;
  }

  // Bir kararin metni kisaldiysa fazlalik chunk'lari sil. Tek statement:
  // bu kosuda uretilmeyen ama bu kararlara ait olan her chunk gider.
  const removed = await queryClient`
    DELETE FROM kvkk.chunks
    WHERE decision_id = ANY(${decisions.map((d) => d.id)}::text[])
      AND NOT (id = ANY(${chunkRows.map((c) => c.id)}::text[]))
  `;
  console.log(
    `   ${chunkRows.length} chunk yazildi ` +
      `(ortalama ${(chunkRows.length / decisions.length).toFixed(1)}/karar` +
      `${removed.count ? `, ${removed.count} eskimis chunk silindi` : ""}).\n`
  );

  // --- 3) Eksik embedding'leri uret ---
  const pending = await queryClient<{ id: string; head: string; text: string }[]>`
    SELECT id, head, text FROM kvkk.chunks WHERE embedding IS NULL ORDER BY id
  `;
  console.log(`3) Embedding: ${pending.length} chunk bekliyor.`);
  if (pending.length === 0) {
    console.log("   Hepsi hazir.\n");
    await finish();
    return;
  }

  const batches = batched(pending, EMBED_BATCH_SIZE);

  let done = 0;
  let failedBatches = 0;
  const started = Date.now();

  // Sabit sayida worker batch kuyrugunu tuketir — HF tarafinda ani yuk olmaz.
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const vectors = await embedPassages(
          batch.map((b) => embedInput(b.head, b.text))
        );
        await queryClient`
          UPDATE kvkk.chunks c
          SET embedding = v.emb::vector, embedded_at = now()
          FROM (
            SELECT * FROM unnest(
              ${batch.map((b) => b.id)}::text[],
              ${vectors.map(toVectorLiteral)}::text[]
            ) AS t(id, emb)
          ) v
          WHERE c.id = v.id
        `;
        done += batch.length;
      } catch (err) {
        failedBatches++;
        console.error(`\n   ! batch atlandi (${batch.length} chunk): ${(err as Error).message}`);
      }
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const eta = rate > 0 ? Math.round((pending.length - done) / rate) : 0;
      process.stdout.write(
        `\r   ${done}/${pending.length} chunk — ${rate.toFixed(1)}/s — kalan ~${eta}s   `
      );
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(
    `\n   tamamlandi: ${done} embedding, ${failedBatches} basarisiz batch, ` +
      `${Math.round((Date.now() - started) / 1000)}s\n`
  );

  await finish();
}

async function finish() {
  const [stats] = await queryClient<
    { decisions: string; chunks: string; embedded: string; missing: string }[]
  >`
    SELECT
      (SELECT count(*) FROM kvkk.decisions)::text AS decisions,
      (SELECT count(*) FROM kvkk.chunks)::text AS chunks,
      (SELECT count(*) FROM kvkk.chunks WHERE embedding IS NOT NULL)::text AS embedded,
      (SELECT count(*) FROM kvkk.chunks WHERE embedding IS NULL)::text AS missing
  `;
  console.log("=== Veritabani durumu ===");
  console.log(`kararlar : ${stats.decisions}`);
  console.log(`chunk'lar: ${stats.chunks}`);
  console.log(`embedding: ${stats.embedded}`);
  if (Number(stats.missing) > 0) {
    console.log(`eksik    : ${stats.missing}  -> "npm run embed" tekrar kos`);
  }
  console.log("\nSirada: npm run db:index\n");
  await queryClient.end();
}

main().catch(async (err) => {
  console.error("\nEmbed basarisiz:", err);
  await queryClient.end().catch(() => {});
  process.exit(1);
});
