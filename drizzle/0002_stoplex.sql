-- Korpusta cok sik gecen lexeme'ler ("stop lexeme").
--
-- Neden gerekli: vektorle bulunan sonuclarda vurgulama gevsek (OR) sorguyla
-- yapiliyor (bkz. src/search/hybrid.ts). Ama KVKK korpusu jenerik hukuk
-- terimleriyle dolu — olcum (3.757 chunk uzerinde ts_stat):
--
--     ver      %92,5      taraf    %82,4
--     kisisel  %86,6      veri     %68,4
--     ilgil    %84,5      madde    %51,8
--
-- Chunk'larin %92'sinde gecen bir terimi isaretlemek hicbir sey anlatmiyor,
-- sadece pasaji okunmaz hale getiriyor. Bu tablo esigi asan lexeme'leri tutar
-- ve vurgulama sorgusundan cikarilmalarini saglar.
--
-- Tablo `npm run db:index` tarafindan doldurulur (korpus degistikce yenilenir),
-- migration yalnizca semayi kurar.

CREATE TABLE IF NOT EXISTS kvkk.stoplex (
  lexeme text PRIMARY KEY,
  ndoc   integer NOT NULL
);
