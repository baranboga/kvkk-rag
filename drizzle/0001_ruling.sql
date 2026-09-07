-- Karar hukmu + yaptirim etiketi (src/extract.ts tarafindan deterministik
-- olarak uretilir; LLM cagrisi yok). Arama sonuclarinda "Sonuc" satiri olarak
-- gosteriliyor.
--
-- Bu kolonlar govdeden TURETILMIS veri: her `npm run embed` kosusunda yeniden
-- yazilirlar. Chunk metnine girmedikleri icin embedding'leri gecersiz kilmazlar.

ALTER TABLE kvkk.decisions ADD COLUMN IF NOT EXISTS ruling text;
ALTER TABLE kvkk.decisions ADD COLUMN IF NOT EXISTS sanction_label text;
ALTER TABLE kvkk.decisions ADD COLUMN IF NOT EXISTS sanction_kind text;
ALTER TABLE kvkk.decisions ADD COLUMN IF NOT EXISTS sanction_amount_try bigint;

-- "Sadece para cezasi verilen kararlar" / "tutara gore sirala" gibi
-- filtrelemeler icin.
CREATE INDEX IF NOT EXISTS decisions_sanction_kind_idx
  ON kvkk.decisions (sanction_kind);
