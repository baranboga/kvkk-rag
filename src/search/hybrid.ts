// SADECE SERVER. Bu modul DB baglantisini ve HF token'ini kullanir; bir client
// component'ten import EDILMEMELI. `server-only` paketini kullanmiyoruz cunku
// bu modul ayni zamanda standalone tsx script'lerinden (scripts/05-search-cli)
// da import ediliyor ve `server-only` Next bundler'i disinda patliyor.
// Pratikte guvence: yalnizca app/api/search/route.ts ve server component'ler
// buraya dokunuyor, ayrica hicbir env degiskeni NEXT_PUBLIC_ almiyor.
import { CANDIDATE_POOL, HNSW_EF_SEARCH, RRF_K } from "../config";
import { queryClient } from "../db/client";
import { embedQuery, toVectorLiteral } from "../embeddings/hf";

export type SearchFilters = {
  yearGte?: number;
  yearLte?: number;
};

export type SearchHit = {
  decisionId: string;
  /** 'karar-ozeti' | 'ilke-karari' */
  source: string;
  /** Eski format bazi karar ozeti sayfalarinda null (sayfada karar no gecmiyor). */
  kararNo: string | null;
  kararTarihi: string | null;
  year: number | null;
  title: string;
  konuOzeti: string | null;
  url: string;
  /** Fuzyon skoru (RRF) — mutlak degeri anlamsiz, yalnizca siralama icin. */
  score: number;
  /** Kac chunk eslesti — kararin sorguyla ne kadar genis ortustugu. */
  matchedChunks: number;
  /** Skoru en yuksek chunk'in metni, cumle basina hizalanmis. */
  snippet: string;
  /** ts_headline ile <mark> isaretlenmis pasaj; hicbir terim gecmiyorsa null. */
  highlighted: string | null;
  /** Kararin hukum paragrafi (govdeden turetilmis, bkz. src/extract.ts). */
  ruling: string | null;
  /** "İdari para cezası · 250.000 TL" gibi kisa yaptirim etiketi. */
  sanctionLabel: string | null;
  sanctionKind: string | null;
  /** Bu karar hangi kollardan geldi — UI'da "neden bulundu"yu gostermek icin. */
  via: ("vector" | "keyword")[];
};

export type SearchResponse = {
  query: string;
  hits: SearchHit[];
  timings: { embedMs: number; retrieveMs: number; totalMs: number };
  counts: { vector: number; keyword: number; fused: number };
};

type CandidateRow = {
  arm: "vector" | "keyword";
  id: string;
  decision_id: string;
  rnk: string; // row_number() bigint döner -> string
};

/**
 * Hybrid arama: pgvector kosinus benzerligi + Turkce full-text, Reciprocal Rank
 * Fusion ile birlestirilir.
 *
 * Neden RRF: iki kolun skorlari farkli olceklerde (kosinus 0-1, ts_rank_cd
 * sinirsiz). Skorlari normalize edip toplamak olcek varsayimlarina bagimli
 * kalirken RRF yalnizca SIRAYI kullanir — kalibrasyon gerektirmez ve hukuki
 * aramada guvenilir davranir.
 *
 * Karar seviyesine cikarken MaxP: kararin skoru = en iyi chunk'inin skoru.
 * Toplama yapmak uzun kararlari (daha fazla chunk) sistematik olarak one
 * cikarirdi.
 */
export async function hybridSearch(
  rawQuery: string,
  limit = 10,
  filters: SearchFilters = {}
): Promise<SearchResponse> {
  const started = Date.now();
  const query = rawQuery.trim();
  if (!query) {
    return {
      query,
      hits: [],
      timings: { embedMs: 0, retrieveMs: 0, totalMs: 0 },
      counts: { vector: 0, keyword: 0, fused: 0 },
    };
  }

  const embedStart = Date.now();
  const vector = await embedQuery(query);
  const embedMs = Date.now() - embedStart;

  const vecLiteral = toVectorLiteral(vector);
  const yearGte = filters.yearGte ?? null;
  const yearLte = filters.yearLte ?? null;

  const retrieveStart = Date.now();

  const hasYearFilter = yearGte !== null || yearLte !== null;

  /**
   * Iki kol TEK statement'ta.
   *
   * Neden: sorgularin kendisi hizli (HNSW ~30ms, GIN ~1ms) ama DB uzak —
   * bos bir `SELECT 1` bile ~250ms. Kollari ayri ayri, ustelik `SET LOCAL`
   * icin transaction icinde kosturmak 5-6 round-trip demekti (~3.7s). Tek
   * statement bunu bire indiriyor.
   *
   * `row_number()`'a ORDER BY'i acikca veriyoruz: bos OVER () ile satir sirasi
   * pratikte alt sorgunun sirasi oluyor ama bu garanti degil, RRF ise tamamen
   * siraya bagli.
   */
  const candidateSql = (sql: typeof queryClient) => sql<CandidateRow[]>`
    WITH vec AS (
      SELECT id, decision_id, row_number() OVER (ORDER BY dist) AS rnk
      FROM (
        SELECT c.id, c.decision_id, c.embedding <=> ${vecLiteral}::vector AS dist
        FROM kvkk.chunks c
        WHERE c.embedding IS NOT NULL
          AND (NOT ${hasYearFilter} OR c.decision_id IN (
            SELECT d.id FROM kvkk.decisions d
            WHERE (${yearGte}::int IS NULL OR d.year >= ${yearGte}::int)
              AND (${yearLte}::int IS NULL OR d.year <= ${yearLte}::int)
          ))
        ORDER BY dist
        LIMIT ${CANDIDATE_POOL}
      ) s
    ),
    kw AS (
      SELECT id, decision_id, row_number() OVER (ORDER BY rank DESC) AS rnk
      FROM (
        SELECT c.id, c.decision_id, ts_rank_cd(c.tsv, tq) AS rank
        FROM kvkk.chunks c,
             websearch_to_tsquery('kvkk.turkish_unaccent', ${query}) AS tq
        WHERE c.tsv @@ tq
          AND (NOT ${hasYearFilter} OR c.decision_id IN (
            SELECT d.id FROM kvkk.decisions d
            WHERE (${yearGte}::int IS NULL OR d.year >= ${yearGte}::int)
              AND (${yearLte}::int IS NULL OR d.year <= ${yearLte}::int)
          ))
        ORDER BY rank DESC
        LIMIT ${CANDIDATE_POOL}
      ) s
    )
    SELECT 'vector'::text AS arm, id, decision_id, rnk FROM vec
    UNION ALL
    SELECT 'keyword'::text AS arm, id, decision_id, rnk FROM kw
  `;

  /**
   * `SET LOCAL` transaction gerektiriyor ama transaction'i tek tek await
   * etmek 5 round-trip demek. postgres-js'e `begin`'den bir DIZI pending
   * sorgu dondurursek hepsini PIPELINE ediyor: BEGIN + SET + sorgu + COMMIT
   * tek gidis-donuste akiyor.
   *
   * ef_search sart: HNSW ef_search'ten fazla satir dondurmuyor, varsayilan 40
   * ise CANDIDATE_POOL'un (60) altinda (bkz. config.ts HNSW_EF_SEARCH).
   *
   * iterative_scan yalnizca filtreli kosuda: HNSW ilk adaylarin cogunu yil
   * filtresine kaptirip LIMIT'ten az sonuc donduruyor; iterative_scan yeterli
   * aday bulunana kadar grafi taramaya devam eder.
   */
  const results = await queryClient.begin((sql) => {
    const stmts: unknown[] = [
      sql.unsafe(`SET LOCAL hnsw.ef_search = ${Number(HNSW_EF_SEARCH)}`),
    ];
    if (hasYearFilter) {
      stmts.push(sql.unsafe(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`));
    }
    stmts.push(candidateSql(sql as unknown as typeof queryClient));
    return stmts as never;
  });

  const rows = (results as unknown as unknown[][]).at(-1) as CandidateRow[];
  const vectorRows = rows.filter((r) => r.arm === "vector");
  const keywordRows = rows.filter((r) => r.arm === "keyword");

  // --- RRF fuzyonu (chunk seviyesinde) ---
  const chunkScores = new Map<
    string,
    { decisionId: string; score: number; via: Set<"vector" | "keyword"> }
  >();

  // Sira SQL'den gelen `rnk` ile geliyor; dizi indeksi kullanilamaz cunku
  // UNION ALL cikti sirasini garanti etmiyor.
  const fuse = (rows: CandidateRow[], arm: "vector" | "keyword") => {
    rows.forEach((row) => {
      const contribution = 1 / (RRF_K + Number(row.rnk));
      const existing = chunkScores.get(row.id);
      if (existing) {
        existing.score += contribution;
        existing.via.add(arm);
      } else {
        chunkScores.set(row.id, {
          decisionId: row.decision_id,
          score: contribution,
          via: new Set([arm]),
        });
      }
    });
  };

  fuse(vectorRows, "vector");
  fuse(keywordRows, "keyword");

  // --- Karar seviyesine cik (MaxP) ---
  const byDecision = new Map<
    string,
    { bestChunk: string; score: number; matched: number; via: Set<"vector" | "keyword"> }
  >();

  for (const [chunkId, s] of chunkScores) {
    const agg = byDecision.get(s.decisionId);
    if (!agg) {
      byDecision.set(s.decisionId, {
        bestChunk: chunkId,
        score: s.score,
        matched: 1,
        via: new Set(s.via),
      });
      continue;
    }
    agg.matched += 1;
    for (const v of s.via) agg.via.add(v);
    if (s.score > agg.score) {
      agg.score = s.score;
      agg.bestChunk = chunkId;
    }
  }

  const top = [...byDecision.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  const retrieveMs = Date.now() - retrieveStart;

  if (top.length === 0) {
    return {
      query,
      hits: [],
      timings: { embedMs, retrieveMs, totalMs: Date.now() - started },
      counts: { vector: vectorRows.length, keyword: keywordRows.length, fused: 0 },
    };
  }

  // --- Metadata + vurgulu pasaj ---
  //
  // Vurgulama, ESLESME sorgusundan AYRI bir sorgu kullanir.
  //
  // Neden eslesme sorgusu kullanilamiyor: `websearch_to_tsquery` terimleri
  // AND'liyor (eslesme tarafinda istedigimiz davranis, secici olsun). Ama ayni
  // sorguyu gosterimde kullanmak, vektorle bulunan sonuclarda `tsv @@ q` false
  // oldugu icin ts_headline'i tamamen devre disi birakiyordu; pasaj chunk'in
  // ham basindan aliniyor ve overlap yuzunden cumlenin ortasindan basliyordu
  // ("yandan, Kanun'un...").
  //
  // Neden ayrica jenerik terimler eleniyor: OR sorgusu "veri", "kisisel" gibi
  // korpusun %90'inda gecen terimleri de isaretliyor ve pasaj okunmaz oluyor.
  // Vurgulamanin isi "bu sonuc NEDEN ilgili" sorusunu gostermek; %92 sikligi
  // olan bir kelime bunu anlatmiyor. Yuksek frekansli lexeme'ler bu yuzden
  // SQL tarafinda eleniyor (kvkk.stoplex, bkz. drizzle/0002_stoplex.sql).
  const relaxedTokens = queryTokens(query);
  const chunkIds = top.map(([, v]) => v.bestChunk);

  const details = await queryClient<
    {
      chunk_id: string;
      decision_id: string;
      source: string;
      karar_no: string | null;
      karar_tarihi: Date | string | null;
      year: number | null;
      title: string;
      konu_ozeti: string | null;
      url: string;
      snippet: string;
      highlighted: string | null;
      ruling: string | null;
      sanction_label: string | null;
      sanction_kind: string | null;
    }[]
  >`
    WITH
    -- Sorgu token'lari + her birinin korpusta jenerik olup olmadigi.
    toks AS (
      SELECT t,
             EXISTS (
               SELECT 1 FROM kvkk.stoplex s
               WHERE s.lexeme = ANY (
                 tsvector_to_array(to_tsvector('kvkk.turkish_unaccent', t))
               )
             ) AS generic
      FROM unnest(${relaxedTokens}::text[]) AS t
    ),
    -- Vurgulama sorgusu: once yalnizca AYIRT EDICI token'lar; sorgunun tamami
    -- jenerik terimlerden olusuyorsa (or. "kişisel veri") hepsine geri dus,
    -- token hic yoksa hicbir seyle eslesmeyen sentinel'e. Sentinel halinde
    -- ts_headline metnin basini verir; cagiran taraf <mark> yoklugundan anlayip
    -- cumleye hizalanmis snippet'e duser.
    hq AS (
      SELECT to_tsquery(
               'kvkk.turkish_unaccent',
               coalesce(
                 nullif(string_agg(t, ' | ') FILTER (WHERE NOT generic), ''),
                 nullif(string_agg(t, ' | '), ''),
                 'zzznomatchzzz'
               )
             ) AS q
      FROM toks
    )
    SELECT
      c.id            AS chunk_id,
      d.id            AS decision_id,
      d.source,
      d.karar_no,
      d.karar_tarihi,
      d.year,
      d.title,
      d.konu_ozeti,
      d.url,
      d.ruling,
      d.sanction_label,
      d.sanction_kind,
      c.text          AS snippet,
      ts_headline(
        'kvkk.turkish_unaccent', c.text, hq.q,
        'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=45, MinWords=20'
      )               AS highlighted
    FROM kvkk.chunks c
    JOIN kvkk.decisions d ON d.id = c.decision_id
    CROSS JOIN hq
    WHERE c.id = ANY(${chunkIds}::text[])
  `;

  const detailById = new Map(details.map((r) => [r.chunk_id, r]));

  const hits: SearchHit[] = top.flatMap(([decisionId, agg]) => {
    const d = detailById.get(agg.bestChunk);
    if (!d) return [];
    // <mark> yoksa sorgudan hicbir terim pasajda gecmiyor demektir; ts_headline
    // bu durumda metnin basini donduruyor, yani ham chunk'tan farki kalmiyor.
    // Boyle hallerde cumle basina hizalanmis snippet daha okunur.
    const marked = d.highlighted?.includes("<mark>") ? d.highlighted : null;
    return [
      {
        decisionId,
        source: d.source,
        kararNo: d.karar_no,
        kararTarihi: d.karar_tarihi ? toIsoDate(d.karar_tarihi) : null,
        year: d.year,
        title: d.title,
        konuOzeti: d.konu_ozeti,
        url: d.url,
        score: agg.score,
        matchedChunks: agg.matched,
        snippet: alignToSentence(d.snippet),
        highlighted: marked,
        ruling: d.ruling,
        sanctionLabel: d.sanction_label,
        sanctionKind: d.sanction_kind,
        via: [...agg.via],
      },
    ];
  });

  return {
    query,
    hits,
    timings: { embedMs, retrieveMs, totalMs: Date.now() - started },
    counts: {
      vector: vectorRows.length,
      keyword: keywordRows.length,
      fused: byDecision.size,
    },
  };
}

/**
 * Sorgu metnini gevsek vurgulama icin token'lara ayirir.
 *
 * Guvenlik: token'lar yalnizca harf/rakam iceriyor, yani tsquery operatoru
 * (`&`, `|`, `!`, `<->`, parantez) enjekte edilemez. Token'lar SQL'e text[]
 * parametresi olarak gidiyor, birlestirme Postgres tarafinda yapiliyor.
 */
function queryTokens(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase("tr").match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/**
 * Pasaji cumle basina hizalar.
 *
 * Chunk'lar 200 karakter overlap ile uretiliyor ve overlap kelime sinirindan
 * kesildigi icin bir chunk cumlenin ortasindan baslayabiliyor ("yandan, Kanun'un
 * ..."). Alintilanabilir olmasi icin bastaki yarim cumleyi at — ama geri kalan
 * cok kisaliyorsa metni oldugu gibi birak.
 */
function alignToSentence(text: string): string {
  const t = text.trim();
  // Buyuk harf / madde isareti / rakam / tirnak ile basliyorsa zaten hizali.
  if (/^[-–—“"'(\d]|^\p{Lu}/u.test(t)) return t;

  const m = t.match(/[.!?]\s+(?=[-–—“"'(\d]|\p{Lu})/u);
  if (m?.index !== undefined) {
    const rest = t.slice(m.index + m[0].length).trim();
    if (rest.length >= 200) return rest;
  }
  return t;
}

/**
 * karar_tarihi -> "YYYY-MM-DD".
 *
 * postgres-js `timestamp without time zone` kolonunu baglantiya gore Date ya da
 * ham string ("2024-12-26 00:00:00") olarak dondurebiliyor; ikisini de karsila.
 * Date'ten UTC degil YEREL bilesenleri okuyoruz — aksi halde saat farki tarihi
 * bir gun kaydirabilir.
 */
function toIsoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
}
