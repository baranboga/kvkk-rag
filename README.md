# kvkk-rag

KVKK (Kişisel Verileri Koruma Kurumu) **kurul karar özetleri** üzerinde semantik
arama ve analiz. Kararların tamamı indekslenir, sorgular hem anlam (vektör) hem
terim (Türkçe full-text) tarafından aranır ve iki sonuç listesi RRF ile
birleştirilir.

İki mod var:

| Mod | Ne yapar | Maliyet |
| --- | --- | --- |
| **Arama** | İlgili kurul kararlarını bulur, eşleşen pasajı vurgular, kararın hükmünü ve yaptırımını gösterir | **Ücretsiz** |
| **Analiz** | Aynı retrieval + LLM'in yalnızca bulunan kararlara dayanarak ürettiği, karar numarasıyla belgelenmiş cevap | Soru başına ~$0,012 |

- **Stack:** Next.js 15 (App Router), TypeScript, Node 20+, Tailwind v4
- **Vektör deposu:** Supabase Postgres + **pgvector** (HNSW, cosine)
- **Embedding:** Hugging Face Inference API — `intfloat/multilingual-e5-large`
  (1024d, açık kaynak, ücretsiz)
- **Cevap üretimi:** OpenAI `gpt-4.1` (yalnızca Analiz modunda)
- **Tüm key'ler server-side.** Hiçbir değişken `NEXT_PUBLIC_` almaz; tarayıcı ne
  HF'e, ne OpenAI'a, ne Postgres'e doğrudan bağlanır — yalnızca `/api/search` ve
  `/api/chat`'e gider. `OPENAI_API_KEY` yoksa arama çalışmaya devam eder,
  yalnızca Analiz sekmesi devre dışı kalır.

---

## Klasör yapısı

```
drizzle/
  0000_init.sql            # şema: pgvector, unaccent'li Türkçe TS config, tablolar, GIN
scripts/
  00-verify-db.ts          # pgvector + HNSW + turkish full-text desteği kontrolü
  01-migrate.ts            # drizzle/*.sql dosyalarını DIRECT_URL üzerinden koşar
  02-scrape.ts             # kvkk.gov.tr -> data/decisions.json  (resume'lu)
  03-embed.ts              # chunk + embed -> Postgres          (resume'lu)
  04-build-indexes.ts      # HNSW indeksi (veri yüklendikten SONRA) + ANALYZE
  05-search-cli.ts         # terminalden arama (UI'sız kalite kontrolü)
  99-reset.ts              # kvkk şemasını düşür (model/boyut değişikliği için)
src/
  config.ts                # model/boyut/chunk/arama parametreleri — tek kaynak
  chunk.ts                 # Türkçe cümle sınırına duyarlı chunking
  extract.ts               # hüküm bloğu + yaptırım çıkarımı (regex, ücretsiz)
  chat.ts                  # retrieval + OpenAI cevap üretimi (Analiz modu)
  corpus.ts                # UI için indeks durumu
  db/{schema,client,direct}.ts
  embeddings/hf.ts         # HF feature-extraction + E5 prefix'leri
  scrape/kvkk.ts           # liste + detay sayfası parser'ları
  search/hybrid.ts         # pgvector + full-text, RRF füzyonu
  app/
    page.tsx               # ana sayfa (server component)
    components/
      Workspace.tsx        # Arama / Analiz sekmeleri
      SearchBar.tsx
      Chat.tsx             # akışlı cevap + tıklanabilir atıflar
    api/search/route.ts
    api/chat/route.ts      # NDJSON akışı: sources -> delta… -> done
data/                      # scrape çıktısı (gitignore)
```

---

## Kurulum

### 1) Bağımlılıklar

```bash
npm install
```

### 2) Ortam değişkenleri

```bash
cp .env.example .env
```

| Değişken | Açıklama |
| --- | --- |
| `HF_TOKEN` | Hugging Face token ("Read" yetkisi yeterli) |
| `HF_EMBEDDING_MODEL` | `intfloat/multilingual-e5-large` (default) |
| `HF_EMBEDDING_DIM` | `1024` (e5-large) / `768` (e5-base) |
| `OPENAI_API_KEY` | **Opsiyonel.** Yalnızca Analiz modu için; yoksa arama çalışır |
| `OPENAI_CHAT_MODEL` | `gpt-4.1` (default) |
| `DATABASE_URL` | Supabase **pooler** (port **6543**) — uygulama sorguları |
| `DIRECT_URL` | Supabase **direct** (port **5432**) — migration / DDL |

> **⚠️ `.env` yalnızca sunucu başlangıcında okunur.** `OPENAI_API_KEY` ekledikten
> sonra `npm run dev`'i yeniden başlatmadan Analiz sekmesi görünmez.

> **⚠️ Pooler uyarısı:** `6543` transaction pooler'dır, prepared statement
> desteklemez. `src/db/client.ts` bağlantıyı `prepare: false` ile kurar. DDL
> (CREATE EXTENSION / CREATE INDEX) pooler üzerinden güvenilir çalışmaz; bu
> yüzden migration ve index script'leri `DIRECT_URL` kullanır. Bu ikisini
> karıştırırsan işlemler anlaşılmaz hatalarla patlar.

---

## Çalıştırma sırası

```bash
npm run verify:db     # pgvector, HNSW, 'turkish' full-text desteği raporu
npm run db:migrate    # kvkk şeması + tablolar + GIN index (DIRECT_URL)
npm run scrape        # data/decisions.json  (36 sayfa -> 310 karar)
npm run embed         # chunk + HF embedding -> Postgres  (3.757 pasaj, ~6 dk)
npm run db:index      # HNSW vektör indeksi + ANALYZE
```

`npm run embed` varsayılan olarak 2 eşzamanlı HF isteği kullanır;
`-- --concurrency 4` ile hızlandırılabilir (ölçülen: ~6,6 pasaj/s).

Ardından:

```bash
npm run dev
# http://localhost:3000
```

Terminalden hızlı kalite kontrolü:

```bash
npm run search -- "güvenlik kamerasıyla ses kaydı alınması"
```

### Kesintiye dayanıklılık

`scrape` ve `embed` **yeniden koşulabilir ve kaldığı yerden devam eder**:

- `scrape` yalnızca `data/decisions.json` içinde olmayan id'leri indirir
  (`--force` ile hepsini yeniden indirir), her 25 kayıtta diske yazar.
- `embed` yalnızca `embedding IS NULL` olan chunk'ları işler. HF rate limit'e
  girip koşu yarıda kalırsa `npm run embed` komutunu tekrar çalıştır.

---

## Tasarım kararları

**Neden hybrid (vektör + full-text)?** Hukuki aramada iki farklı ihtiyaç var:
"biyometrik veriyle mesai takibi" gibi kavramsal sorgular vektör tarafını,
"2024/2196", "12 nci madde", "fidye yazılımı" gibi tam terimler full-text
tarafını gerektiriyor. Tek başına vektör araması ikinci grubu kaçırıyor.

**Neden RRF (Reciprocal Rank Fusion)?** İki kolun skorları farklı ölçeklerde
(cosine 0–1, `ts_rank_cd` sınırsız). Skorları normalize edip toplamak ölçek
varsayımlarına bağımlı kalır; RRF yalnızca **sırayı** kullanır, kalibrasyon
gerektirmez.

**Neden `turkish_unaccent` text search config?** Kullanıcılar "guvenlik",
"sifreleme" gibi ASCII yazımlar deniyor. `unaccent` + `turkish_stem` mapping'i
hem diyakritikleri hem ekleri normalize ediyor ("kararlarında" → "karar").
`to_tsvector(regconfig, text)` IMMUTABLE olduğu için bu config GENERATED
kolonda kullanılabiliyor.

**Neden chunk seviyesinde arama, karar seviyesinde sonuç?** Kararlar ortalama
~12 bin karakter; tek vektörle temsil edilirse spesifik bir gerekçe kayboluyor.
Chunk'lar aranıp **MaxP** (kararın skoru = en iyi chunk'ının skoru) ile karar
seviyesine çıkılıyor. Skor toplamak uzun kararları sistematik olarak öne
çıkarırdı.

**Neden `chunks.head` ayrı bir kolon?** Karar gövdesi "veri sorumlusu", "ilgili
kişi" gibi genel ifadelerle yazılmış; hangi sektör/olay olduğu çoğu zaman
yalnızca başlıkta geçiyor. Bu yüzden kararın Konu Özeti her chunk'a
denormalize edilir ve **hem embedding girdisine hem tsvector'e** girer —
"hastane kayıtları" gibi bir sorgu böylece doğru kararı bulur. Ama UI'da
gösterilen pasaj yalnızca `text`; başlığı chunk metnine gömmek snippet'in
başlığı tekrar etmesine yol açardı. (GENERATED kolon başka tabloya bakamadığı
için denormalizasyon zorunlu.)

**Neden E5 prefix'leri?** `intfloat/multilingual-e5-*` modelleri asimetrik
eğitildi: doküman `passage: `, sorgu `query: ` prefix'i ister. Prefix'i atlamak
recall'u belirgin düşürür. `src/config.ts` model adında "e5" yoksa prefix'i
otomatik kapatır.

**Neden HNSW migration'da değil?** Boş tabloya index kurup 3–4 bin satır yazmak,
veriyi yazıp sonra index kurmaktan hem yavaş hem daha düşük kaliteli graf
üretir. Bu yüzden `npm run db:index` ayrı adım.

**Neden iki arama kolu tek SQL statement'ında?** Sorguların kendisi hızlı
(ölçülen: HNSW ~30 ms, GIN ~1 ms) ama DB uzak — boş bir `SELECT 1` bile
~250 ms. Kolları ayrı ayrı, üstelik `SET LOCAL` için transaction içinde
koşturmak 5–6 round-trip demekti (~3,7 s). Tek statement + postgres-js'in
transaction pipeline'ı bunu ~0,9 s'ye indirdi.

> **⚠️ `HNSW_EF_SEARCH` ile `CANDIDATE_POOL` bağlantılı.** HNSW bir sorguda
> `ef_search`'ten fazla satır döndürmez. pgvector varsayılanı 40; pool 60 iken
> `SET LOCAL hnsw.ef_search` atlanırsa LIMIT'e rağmen sessizce 40 aday gelir ve
> füzyon zayıflar. `src/config.ts` bu yüzden ikisini birlikte tutuyor.

**Neden vurgulama, eşleşme sorgusundan ayrı bir sorgu kullanıyor?** Eşleşmede
`websearch_to_tsquery` terimleri AND'liyor — seçici olması istediğimiz davranış.
Ama aynı sorguyu gösterimde kullanmak, vektörle bulunan sonuçlarda `tsv @@ q`
false olduğu için `ts_headline`'ı tamamen devre dışı bırakıyordu: pasaj chunk'ın
ham başından alınıyor ve overlap yüzünden cümlenin ortasından başlıyordu
("yandan, Kanun'un…"). Vurgulama artık gevşek (OR) bir sorguyla yapılıyor.

**Neden `kvkk.stoplex`?** Gevşek sorgu "veri", "kişisel" gibi terimleri de
işaretliyordu — ölçüm (`ts_stat`, 3.757 chunk): `ver` %92,5, `kisisel` %86,6,
`ilgil` %84,5. Korpusun %92'sinde geçen bir kelimeyi vurgulamak "bu sonuç neden
ilgili" sorusuna cevap vermiyor, sadece pasajı okunmaz yapıyor. `npm run db:index`
DF > %25 olan lexeme'leri (46 tane) bu tabloya yazıyor ve vurgulama sorgusundan
eleniyor. Sorgunun tamamı jenerik terimden oluşuyorsa (ör. "kişisel veri")
hepsine geri düşülüyor — hiç vurgu olmamasından iyi.

**Neden hüküm ayrı bir blok olarak çıkarılıyor?** KVKK kararları tutarlı bir
kuyruk yapısı izliyor: gerekçe maddeleri (`<ul>`) → "hususları dikkate
alındığında…" operatif paragraf → `karar verilmiştir.` Bu son cümle çoğu zaman
18 karakterlik ayrı bir paragraf (310 kararın 203'ünde), dolayısıyla yalnızca
onu almak hiçbir bilgi vermiyor. `src/extract.ts` bloğun sonunu "karar veril…"
ile, başını operatif açılış kalıbıyla bulur; kalıp yoksa karakter bütçesiyle
geriye gider. Kapsam: **298/310**.

**Neden yaptırım yalnızca hüküm bloğundan çıkarılıyor?** "idari para cezası",
"şikâyetin reddine" gibi ifadeler kararın anlatı kısmında da geçiyor (tarafların
iddiaları, mevzuat alıntıları, önceki kararlara atıflar). Gövdenin tamamına
bakmak yanlış etiket üretiyordu.

---

## Model / boyut değiştirmek

`HF_EMBEDDING_DIM` şemadaki `vector(N)` kolonunu belirler, yani boyut
değişikliği şema değişikliğidir:

```bash
# .env içinde HF_EMBEDDING_MODEL + HF_EMBEDDING_DIM güncelle, sonra:
npm run db:reset -- --yes   # kvkk şemasını düşürür; data/decisions.json'a dokunmaz
npm run db:migrate
npm run embed               # scrape'i tekrarlamaya gerek yok
npm run db:index
```

`npm run verify:db` tablodaki boyutla `.env`'in uyuşmadığını tespit edip uyarır.

---

## Maliyet ve sınırlar

Ölçülen durum (310 karar / 3.757 pasaj / 1024 boyut):

| Bileşen | Servis | Durum |
| --- | --- | --- |
| Embedding | HF Inference API | Ücretsiz katman — indeksleme 3.757 çağrı (tek seferlik), arama başına 1 çağrı |
| Veritabanı | Supabase Postgres + pgvector | `kvkk` şeması **69 MB** (500 MB ücretsiz limitten) |
| Hüküm / yaptırım özeti | — | Deterministik regex çıkarımı (`src/extract.ts`), API çağrısı yok |
| Cevap üretimi (Analiz) | OpenAI `gpt-4.1` | Ölçülen: soru başına ~3.200 girdi + ~700 çıktı token ≈ **$0,012** |

Analiz maliyeti yalnızca kullanıcı soru sorduğunda oluşur; arama ve karar
listeleme hiçbir ücretli servise dokunmaz. UI her cevabın altında gerçek token
kullanımını ve tahmini maliyeti gösterir (`Chat.tsx` içindeki fiyat sabitleri
gpt-4.1 liste fiyatıdır: 1M girdi $2 / 1M çıktı $8).

İki sınıra dikkat:

1. **HF ücretsiz katmanının aylık kredisi var.** Limit aşılırsa HF 429 döner;
   `src/embeddings/hf.ts` exponential backoff ile 6 kez dener, `/api/search`
   ise kullanıcıya anlaşılır bir mesaj gösterir. Toplu indekslemede
   `npm run embed` kaldığı yerden devam ettiği için koşuyu tekrarlamak yeter.
2. **Supabase ücretsiz projeler ~7 gün hareketsizlikte duraklatılır**, panelden
   elle devam ettirmek gerekir.

---

## Bilinen sorunlar

- **KVKK'nın kendi kırık linkleri.** Liste sayfalarındaki 3 kayıt
  (`/Icerik/5462/2019/47`, `5464/2019/52`, `5461/2019/122`) kaynak sitede
  anasayfaya yönleniyor; indekslenemiyor. `data/scrape-report.json` içinde
  `failed` altında listelenir.
- **Numarasız kararlar.** Eski format bazı karar sayfalarında karar no sayfanın
  hiçbir yerinde geçmiyor (11 kayıt). `karar_no` bu kayıtlarda `NULL`, UI'da
  `no'suz` olarak gösterilir. Karar tarihi de yoksa `year` de `NULL` olur ve
  kayıt yıl filtresine girmez — yayınlanma tarihini karar tarihi yerine
  kullanmıyoruz, çünkü site 2024 tarihli bir kararı 2026'da yayınlayabiliyor.
- **Birleşik kararlar.** Bazı sayfalar tek metinde birden fazla karar taşıyor
  (`2021/511-512-513`, `2019/81 ve 2019/165`). Bu değerler olduğu gibi saklanır.
- **TLS araya giren ortamlar.** Makinede kurumsal proxy / antivirüs HTTPS
  taraması varsa (`NODE_EXTRA_CA_CERTS` ayarlıysa) `npm run dev` komutunu
  **kendi terminalinden** çalıştır. Next dev worker'ı bu değişkenleri yalnızca
  ortamdan miras alır; sanitize edilmiş bir ortamdan başlatılırsa HF çağrısı
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` ile patlar.

---

## Notlar

- Scrape kibar davranır: istekler arası `SCRAPE_DELAY_MS` (400 ms) bekleme,
  hatalarda exponential backoff.
- `data/scrape-report.json` her koşuda üretilir: kaç karar indi, hangi meta
  alanları görüldü, hangi URL'ler parse edilemedi.
- Sayfa sayısı sabit değil — scraper pagination'daki en büyük `?page=N`
  değerini her koşuda yeniden okur (bugün 36).
- Bu bir resmî yayın değildir; bağlayıcı metin için `kvkk.gov.tr` esas alınmalı.
