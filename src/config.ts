import { optionalEnv } from "./env";

// ---------------------------------------------------------------------------
// Kaynak site
// ---------------------------------------------------------------------------

export const KVKK_ORIGIN = "https://www.kvkk.gov.tr";

/** Kararin hangi kulliyattan geldigi. */
export type SourceKey = "karar-ozeti";

/**
 * Indekslenen kulliyat(lar). Liste parser'i markup'a (.members__item) bagli,
 * KVKK'nin diger karar listeleri de ayni markup'i kullaniyor — yeni bir kaynak
 * eklemek buraya bir satir eklemek demek.
 */
export const SOURCES: { key: SourceKey; label: string; path: string }[] = [
  {
    key: "karar-ozeti",
    label: "Kurul Karar Özeti",
    path: "/Icerik/5406/kurul-karar-ozetleri",
  },
];

/**
 * Liste sayfa sayisi ust siniri. Scraper gercek sayfa sayisini pagination'dan
 * her kosuda yeniden okur (bugun 36).
 */
export const KVKK_MAX_PAGES = 60;

/** Sunucuya kibar davran: her istek arasi bekleme (ms). */
export const SCRAPE_DELAY_MS = 400;

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export const HF_EMBEDDING_MODEL = optionalEnv(
  "HF_EMBEDDING_MODEL",
  "intfloat/multilingual-e5-large"
);

export const HF_EMBEDDING_DIM = Number(optionalEnv("HF_EMBEDDING_DIM", "1024"));

/**
 * E5 aile modelleri asimetrik egitildi: dokuman "passage: ", sorgu "query: "
 * prefix'i ISTER. Prefix'i unutmak recall'u belirgin dusurur. E5 olmayan
 * modeller (or. MiniLM) prefix kullanmaz.
 */
const IS_E5 = /e5/i.test(HF_EMBEDDING_MODEL);
export const HF_PASSAGE_PREFIX = IS_E5 ? "passage: " : "";
export const HF_QUERY_PREFIX = IS_E5 ? "query: " : "";

/** Tek HF isteginde kac metin gonderilecek. */
export const EMBED_BATCH_SIZE = 8;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * E5 modelleri 512 token'da kesiyor. Turkce'de multilingual tokenizer ~3 kar/token
 * uretiyor, yani ~1500 karakter guvenli ust sinir. 1200 hedef + 200 overlap
 * hem sinirin altinda kaliyor hem cumle butunlugunu koruyor.
 */
export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 200;
export const CHUNK_MIN_CHARS = 120;

// ---------------------------------------------------------------------------
// Arama
// ---------------------------------------------------------------------------

/** Hybrid fuzyonda her iki koldan cekilen aday chunk sayisi. */
export const CANDIDATE_POOL = 60;

/** RRF sabiti: kucuk k ust siralari daha cok odullendirir. */
export const RRF_K = 60;

/**
 * HNSW arama genisligi; buyudukce recall artar, latency artar.
 *
 * DIKKAT: HNSW bir sorguda ef_search'ten FAZLA satir dondurmez. Bu deger
 * CANDIDATE_POOL'un altina duserse LIMIT'e ragmen daha az aday gelir ve
 * fuzyon sessizce zayiflar (pgvector varsayilani 40 — pool 60 iken sessizce
 * 40 aday doner). Bu yuzden ikisi burada birlikte tutuluyor.
 */
export const HNSW_EF_SEARCH = Math.max(100, CANDIDATE_POOL);
