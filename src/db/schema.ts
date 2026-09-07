import {
  bigint,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { HF_EMBEDDING_DIM } from "../config";

/**
 * Ayri schema: bu Supabase instance'i baska projelerle paylasiliyor,
 * `public` altindaki tablolara hic dokunmuyoruz.
 */
export const kvkk = pgSchema("kvkk");

/** Bir KVKK karari = bir dokuman. */
export const decisions = kvkk.table(
  "decisions",
  {
    /**
     * URL'den deterministik turetilen kimlik:
     *   "icerik:8870"   -> kvkk.gov.tr/Icerik/8870/...
     *   "rg:20260728-6" -> resmigazete.gov.tr/.../20260728-6.pdf
     */
    id: text("id").primaryKey(),
    /** 'karar-ozeti' | 'ilke-karari' (bkz. src/config.ts SOURCES). */
    source: text("source").notNull(),
    /** "2024/2196". Eski format ilke kararlarinda sayfada hic gecmiyor -> null. */
    kararNo: text("karar_no"),
    /** Karar tarihi; site formatlari tutarsiz oldugu icin nullable. */
    kararTarihi: timestamp("karar_tarihi", { withTimezone: false }),
    /** Karar No'dan turetilen yil — filtreleme icin. */
    year: integer("year"),
    /** Sayfadaki uzun baslik. */
    title: text("title").notNull(),
    /** Tablodaki "Konu Ozeti" satiri. */
    konuOzeti: text("konu_ozeti"),
    /** Tablodaki diger anahtar/deger satirlari (Hukuki Dayanak, Karar Sonucu...). */
    meta: text("meta"),
    /** Kararin duz metin govdesi. */
    body: text("body").notNull(),
    /** Govdeden turetilen hukum paragrafi (bkz. src/extract.ts). */
    ruling: text("ruling"),
    /** "İdari para cezası · 250.000 TL" gibi kisa yaptirim etiketi. */
    sanctionLabel: text("sanction_label"),
    /** "idari-para-cezasi" | "talimat" | "islem-yok" | "ret" */
    sanctionKind: text("sanction_kind"),
    sanctionAmountTry: bigint("sanction_amount_try", { mode: "number" }),
    url: text("url").notNull(),
    charCount: integer("char_count").notNull(),
    scrapedAt: timestamp("scraped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("decisions_karar_no_idx").on(t.kararNo),
    index("decisions_year_idx").on(t.year),
    index("decisions_source_idx").on(t.source),
  ]
);

/**
 * Arama birimi. Embedding ve full-text her ikisi de chunk seviyesinde;
 * sonuclar UI'da karara gore gruplanir.
 *
 * `tsv` kolonu migration'da GENERATED ALWAYS olarak tanimli (to_tsvector('turkish', ...)),
 * bu yuzden burada semaya dahil edilmedi — Drizzle ona hic yazmamali.
 */
export const chunks = kvkk.table(
  "chunks",
  {
    id: text("id").primaryKey(), // "<decisionId>#<chunkIndex>"
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    /** Kararin Konu Ozeti/basligi — embedding girdisine ve tsv'ye girer, UI'da gosterilmez. */
    head: text("head").notNull().default(""),
    text: text("text").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    embedding: vector("embedding", { dimensions: HF_EMBEDDING_DIM }),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("chunks_decision_index_idx").on(t.decisionId, t.chunkIndex),
    index("chunks_decision_idx").on(t.decisionId),
  ]
);

export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
