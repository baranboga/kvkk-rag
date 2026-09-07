-- KVKK RAG — sema kurulumu
--
-- __DIM__ yer tutucusu scripts/01-migrate.ts tarafindan HF_EMBEDDING_DIM ile
-- degistirilir. Bu dosyayi elle psql'e vermeyeceksen dokunma; embedding
-- boyutu tek kaynak olarak .env icindeki HF_EMBEDDING_DIM'dir.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE SCHEMA IF NOT EXISTS kvkk;

-- ---------------------------------------------------------------------------
-- Turkce + diyakritik-duyarsiz full-text konfigurasyonu
--
-- Kullanicilar "guvenlik", "sifreleme", "ihlal bildirimi" gibi ASCII yazimlar
-- deniyor; unaccent sozlugu hem indeks hem sorgu tarafinda "güvenlik" ile
-- eslesmesini sagliyor. turkish_stem ekleri kaldirir ("kararlarinda" -> "karar").
--
-- NOT: to_tsvector(regconfig, text) IMMUTABLE oldugu icin bu konfigurasyon
-- generated column icinde kullanilabiliyor. Konfigurasyonu sonradan degistirirsen
-- chunks.tsv kolonunu DROP/ADD ile yeniden uretmen gerekir.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config c
    JOIN pg_namespace n ON n.oid = c.cfgnamespace
    WHERE c.cfgname = 'turkish_unaccent' AND n.nspname = 'kvkk'
  ) THEN
    CREATE TEXT SEARCH CONFIGURATION kvkk.turkish_unaccent (COPY = pg_catalog.turkish);
    ALTER TEXT SEARCH CONFIGURATION kvkk.turkish_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, turkish_stem;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- decisions: bir satir = bir kurul karar ozeti
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kvkk.decisions (
  -- text PK cunku iki farkli barindiricidan geliyor ve ikisinin de kendi
  -- numaralandirmasi var: "icerik:8870" (kvkk.gov.tr) / "rg:20260728-6"
  -- (resmigazete.gov.tr PDF'i). Ikisi de URL'den deterministik turetilir.
  id            text PRIMARY KEY,
  -- 'karar-ozeti' | 'ilke-karari' (bkz. src/config.ts SOURCES)
  source        text        NOT NULL,
  -- Eski format bazi karar ozeti sayfalarinda karar no hic gecmiyor -> nullable.
  -- Unique index NULL'lari birbirinden farkli sayar, cakisma olmaz.
  karar_no      text,
  karar_tarihi  timestamp,
  year          integer,
  title         text        NOT NULL,
  konu_ozeti    text,
  meta          text,
  body          text        NOT NULL,
  url           text        NOT NULL,
  char_count    integer     NOT NULL,
  scraped_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS decisions_karar_no_idx ON kvkk.decisions (karar_no);
CREATE INDEX IF NOT EXISTS decisions_year_idx ON kvkk.decisions (year);
CREATE INDEX IF NOT EXISTS decisions_source_idx ON kvkk.decisions (source);

-- ---------------------------------------------------------------------------
-- chunks: arama birimi (hem vektor hem full-text bu tabloda)
-- ---------------------------------------------------------------------------
-- `head`: kararin Konu Ozeti/basligi, her chunk'a denormalize edilir.
--
-- Iki nedenle ayri kolon:
--  1) Embedding girdisi "head + text" olmali — karar govdesi "veri sorumlusu",
--     "ilgili kisi" gibi genel ifadelerle yazilmis; hangi sektor/olay oldugu
--     cogu zaman yalnizca baslikta geciyor.
--  2) tsv de head'i icermeli ki "sigorta sirketi" gibi sorgular kararin tum
--     pasajlarindan yakalanabilsin.
-- Ama GOSTERILEN pasaj yalnizca `text` — aksi halde snippet basligi tekrar eder.
-- GENERATED kolon baska tabloya bakamadigi icin denormalizasyon zorunlu.
CREATE TABLE IF NOT EXISTS kvkk.chunks (
  id              text PRIMARY KEY,
  decision_id     text    NOT NULL REFERENCES kvkk.decisions (id) ON DELETE CASCADE,
  chunk_index     integer NOT NULL,
  head            text    NOT NULL DEFAULT '',
  text            text    NOT NULL,
  token_estimate  integer NOT NULL,
  embedding       vector(__DIM__),
  embedded_at     timestamptz,
  tsv             tsvector GENERATED ALWAYS AS
                    (to_tsvector(
                      'kvkk.turkish_unaccent',
                      coalesce(head, '') || ' ' || text
                    )) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS chunks_decision_index_idx
  ON kvkk.chunks (decision_id, chunk_index);
CREATE INDEX IF NOT EXISTS chunks_decision_idx ON kvkk.chunks (decision_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON kvkk.chunks USING gin (tsv);

-- HNSW vektor indeksi BURADA OLUSTURULMAZ. Bos tabloya index kurup sonra
-- 3-4 bin satir yazmak, veriyi yazip sonra index kurmaktan hem yavas hem
-- daha dusuk kaliteli graf uretir. Bkz. npm run db:index (scripts/04).
