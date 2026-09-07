import * as cheerio from "cheerio";
import {
  KVKK_MAX_PAGES,
  KVKK_ORIGIN,
  SCRAPE_DELAY_MS,
  type SourceKey,
} from "../config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Liste sayfasindaki bir kayit: baslik + detay linki. */
export type ListItem = {
  /**
   * Stabil dokuman kimligi: "icerik:8870" -> kvkk.gov.tr/Icerik/8870/...
   * URL'den deterministik turetilir, yani yeniden kosuda degismez.
   */
  id: string;
  url: string;
  listTitle: string;
  source: SourceKey;
};

/** Detay sayfasindan cikarilan tam kayit. */
export type ScrapedDecision = {
  id: string;
  url: string;
  source: SourceKey;
  /**
   * "2024/2196". Eski format bazi karar ozeti sayfalarinda (or. /Icerik/5412/
   * Acik-Rizanin-Hizmet-Sartina-Baglanmasi) sayfada hicbir yerde karar no
   * gecmiyor — bu kayitlar icin null.
   */
  kararNo: string | null;
  kararTarihi: string | null; // ISO "YYYY-MM-DD"
  year: number | null;
  title: string;
  konuOzeti: string | null;
  meta: Record<string, string>;
  body: string;
  charCount: number;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchWithRetry(url: string, attempt = 0): Promise<Response> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return fetchWithRetry(url, attempt + 1);
    }
    throw new Error(`${url} alinamadi: ${(err as Error).message}`);
  }
}

const fetchHtml = (url: string) => fetchWithRetry(url).then((r) => r.text());

const clean = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** URL -> stabil dokuman kimligi. Taniyamazsa null (kayit atlanir). */
function idFromUrl(url: string): string | null {
  const icerik = url.match(/\/Icerik\/(\d+)\//);
  return icerik ? `icerik:${icerik[1]}` : null;
}

// ---------------------------------------------------------------------------
// Liste sayfalari
// ---------------------------------------------------------------------------

/**
 * Pagination'daki en buyuk sayfa numarasini okur. Site ">>" linkini son sayfaya
 * baglar; sayfa sayisi zamanla artacagi icin sabit deger yerine bunu kullaniyoruz.
 */
export function parseLastPage($: cheerio.CheerioAPI): number {
  let last = 1;
  $("a[href*='page=']").each((_, el) => {
    const m = ($(el).attr("href") ?? "").match(/[?&]page=(\d+)/);
    if (m) last = Math.max(last, Number(m[1]));
  });
  return Math.min(last, KVKK_MAX_PAGES);
}

export function parseListPage(
  html: string,
  source: SourceKey
): { items: ListItem[]; lastPage: number } {
  const $ = cheerio.load(html);
  const items: ListItem[] = [];

  $(".members__item .members__item-meta").each((_, el) => {
    const $el = $(el);
    const href = $el.find("a.read-more").attr("href");
    if (!href) return;
    const abs = new URL(href, KVKK_ORIGIN).toString();
    const id = idFromUrl(abs);
    if (!id) return;
    items.push({ id, url: abs, listTitle: clean($el.find("h2").text()), source });
  });

  return { items, lastPage: parseLastPage($) };
}

/** Bir kulliyatin tum liste sayfalarini gezip benzersiz kayitlari toplar. */
export async function crawlList(
  source: SourceKey,
  path: string,
  onPage?: (page: number, lastPage: number, found: number) => void
): Promise<ListItem[]> {
  const seen = new Map<string, ListItem>();
  let page = 1;
  let lastPage = 1;

  while (page <= lastPage || page === 1) {
    const html = await fetchHtml(`${KVKK_ORIGIN}${path}?page=${page}`);
    const { items, lastPage: parsed } = parseListPage(html, source);
    if (page === 1) lastPage = parsed;

    for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
    onPage?.(page, lastPage, items.length);

    // Bos sayfa = pagination bitti (site sayfa sayisini degistirmis olabilir).
    if (items.length === 0 && page > 1) break;

    page += 1;
    if (page <= lastPage) await sleep(SCRAPE_DELAY_MS);
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Tarih / karar no ayikilama
// ---------------------------------------------------------------------------

/** "26/12/2024" veya "26.12.2024" -> "2024-12-26". */
function parseTrDate(raw: string): string | null {
  const m = clean(raw).match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "2024/2196" -> 2024. Karar tarihi eksikse yil buradan gelir. */
function yearFromKararNo(kararNo: string): number | null {
  const m = kararNo.match(/(\d{4})\s*\//);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 2016 && y <= 2100 ? y : null;
}

/**
 * Karar no'yu sirayla dener: meta tablosu -> URL slug'i ("2024-2196") ->
 * baslik metni ("... 2026/921 Sayili Ilke Karari").
 */
function findKararNo(
  meta: Record<string, string>,
  url: string,
  title: string
): string | null {
  if (meta["Karar No"]) return meta["Karar No"];

  const slug = url.match(/\/(\d{4})-(\d+)\/?$/);
  if (slug) return `${slug[1]}/${slug[2]}`;

  const inTitle = title.match(/(\d{4})\s*\/\s*(\d+)\s*[Ss]ay/);
  if (inTitle) return `${inTitle[1]}/${inTitle[2]}`;

  return null;
}

/**
 * Ilke karari basliklarindan konu ozetini ayirir:
 *   "Mesai Takibi Amaciyla Biyometrik Veri Islenmesi Hakkinda Kisisel Verileri
 *    Koruma Kurulunun 29.04.2026 Tarihli ve 2026/921 Sayili Ilke Karari"
 *   -> "Mesai Takibi Amaciyla Biyometrik Veri Islenmesi"
 */
function konuFromTitle(title: string): string | null {
  const m = title.match(/^["“]?(.+?)["”]?\s+(?:hakk[ıi]nda|Hakk[ıi]nda)\s+Kişisel/u);
  const candidate = m?.[1]?.trim();
  return candidate && candidate.length > 10 ? candidate : null;
}

// ---------------------------------------------------------------------------
// HTML detay sayfasi
// ---------------------------------------------------------------------------

/**
 * Detay sayfasindaki meta tablosu: her satir <td>ETIKET</td><td>:</td><td>DEGER</td>.
 * Bazi kararlarda 3 yerine 2 hucre var; ikisini de karsila.
 */
function parseMetaTable($: cheerio.CheerioAPI, $article: cheerio.Cheerio<never>) {
  const meta: Record<string, string> = {};
  $article
    .find("table")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr)
        .find("td, th")
        .map((__, td) => clean($(td).text()))
        .get()
        .filter((c) => c !== ":" && c !== "");
      if (cells.length >= 2) {
        const key = cells[0].replace(/\s*:\s*$/, "");
        // Eski format sayfalarda ":" ayri bir <td> DEGIL, deger hucresinin
        // basinda geliyor (": 2020/86"); bir kisminda ise etiketin kendisi
        // deger hucresinde tekrar ediyor ("Konu Özeti : Ilgili kisinin...").
        // Ikisini de temizle, aksi halde karar no'lar ": 2020/86" olarak kalir.
        const value = cells
          .slice(1)
          .join(" ")
          .replace(new RegExp(`^${escapeRegExp(key)}\\s*`, "i"), "")
          .replace(/^[:–-]\s*/, "")
          .trim();
        if (key && value) meta[key] = value;
      }
    });
  return meta;
}

/**
 * Karar govdesi: meta tablosundan SONRA gelen tum blok elemanlar.
 * <ul> maddeleri "- " ile isaretlenir, cunku listeler kararin hukuki
 * gerekcelerini tasiyor ve chunk icinde madde sinirlari kaybolmamali.
 */
function parseBody($: cheerio.CheerioAPI, $article: cheerio.Cheerio<never>): string {
  const $table = $article.find("table").first();
  const parts: string[] = [];

  const collect = (el: never) => {
    const $el = $(el);
    const tag = ($el.prop("tagName") as string | undefined)?.toLowerCase();
    if (!tag) return;
    if (tag === "ul" || tag === "ol") {
      $el.find("li").each((_, li) => {
        const t = clean($(li).text());
        if (t) parts.push(`- ${t}`);
      });
    } else {
      const t = clean($el.text());
      if (t) parts.push(t);
    }
  };

  if ($table.length) {
    $table.nextAll().each((_, el) => collect(el as never));
  } else {
    // Meta tablosu yoksa basliktan sonraki her seyi al.
    $article.children().each((_, el) => {
      if ($(el).hasClass("news__detail-article-title")) return;
      collect(el as never);
    });
  }

  return parts.join("\n\n");
}

export function parseDetailPage(html: string, item: ListItem): ScrapedDecision | null {
  const $ = cheerio.load(html);
  const $article = $(".news__detail-article").first() as unknown as cheerio.Cheerio<never>;
  // Sayfa yok / anasayfaya yonlenmis (KVKK'nin kendi kirik linkleri).
  if (!$article.length) return null;

  const title =
    clean($article.find(".news__detail-article-title").first().text()) || item.listTitle;
  const meta = parseMetaTable($, $article);
  const body = parseBody($, $article);

  // Govde zorunlu; karar no degil (bkz. ScrapedDecision.kararNo).
  if (!body) return null;

  const kararNo = findKararNo(meta, item.url, `${title} ${item.listTitle}`);
  const kararTarihi =
    parseTrDate(meta["Karar Tarihi"] ?? "") ??
    parseTrDate(title) ??
    parseTrDate(item.listTitle);

  return {
    id: item.id,
    url: item.url,
    source: item.source,
    kararNo,
    kararTarihi,
    year: yearOf(kararTarihi, kararNo),
    title,
    konuOzeti:
      meta["Konu Özeti"] ?? meta["Konu Ozeti"] ?? konuFromTitle(title) ?? null,
    meta,
    body,
    charCount: body.length,
  };
}

/**
 * Yayinlanma tarihini yil kaynagi olarak KULLANMIYORUZ: site 26/12/2024 tarihli
 * karari 10/08/2026'da yayinlayabiliyor, ikisi ayni sey degil. Karar tarihi ve
 * karar no yoksa yil bilinmiyor -> null.
 */
function yearOf(kararTarihi: string | null, kararNo: string | null): number | null {
  if (kararTarihi) return Number(kararTarihi.slice(0, 4));
  return kararNo ? yearFromKararNo(kararNo) : null;
}

/** Bir detay sayfasini indirip parse eder. */
export async function fetchDecision(item: ListItem): Promise<ScrapedDecision | null> {
  return parseDetailPage(await fetchHtml(item.url), item);
}
