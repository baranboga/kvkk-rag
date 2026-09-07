/**
 * Karar govdesinden HUKUM ve YAPTIRIM cikarimi.
 *
 * Tamamen deterministik (regex) — LLM cagrisi yok, dolayisiyla maliyeti yok.
 *
 * KVKK karar ozetleri tutarli bir kuyruk yapisi izliyor:
 *
 *     - [gerekce maddeleri, <ul> icinde, "- " onekli]
 *     - ...
 *     hususlari dikkate alindiginda, ... [OPERATIF HUKUM]
 *     [bazen ek operatif paragraflar]
 *     karar verilmiştir.
 *
 * Yani hukum tek bir paragraf DEGIL, govdenin sonundaki bir BLOK. "karar
 * verilmiştir." cogu zaman 18 karakterlik ayri bir paragraf olarak duruyor
 * (olcum: 310 kararin 203'unde boyle), bu yuzden yalnizca o paragrafi almak
 * hicbir bilgi vermiyor.
 */

/** Hukum blogunu KAPATAN ifade. */
const RULING_END = /karar veril(?:miş|mesi)/i;

/**
 * Hukum blogunu ACAN ifadeler. KVKK kararlari operatif kismi neredeyse her
 * zaman bu kaliplardan biriyle baslatiyor (olcum: "dikkate alındığında"
 * 199/310, "incelenmesi neticesinde" 110/310).
 */
const RULING_START =
  /dikkate\s+alındığında|değerlendiril(?:mesi|diğinde)\s+netice|incelen(?:mesi|diğinde)\s+netice|inceleme\s+neticesinde/i;

/** Anchor aranirken sonda kac paragraf geriye gidilecegi. */
const ANCHOR_LOOKBACK = 6;
/** Anchor bulunamazsa blogun hedeflenen minimum uzunlugu. */
const FALLBACK_MIN_CHARS = 400;
const FALLBACK_MAX_PARAS = 4;

/**
 * Kararin operatif hukum blogu.
 *
 * Bloğun SONU: "karar veril..." iceren son paragraf.
 * Bloğun BASI: oradan geriye dogru en yakin RULING_START kalibi; bulunamazsa
 * karakter butcesiyle geriye gidilir (kararlarin bir kismi "Aciklanan mevzuat
 * hukumleri uyarinca..." gibi kalip disi bir acilis kullaniyor).
 */
export function extractRuling(body: string): string | null {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) return null;

  const end = paras.findLastIndex((p) => RULING_END.test(p));
  if (end < 0) return null;

  let start = -1;
  for (let i = end; i >= 0 && end - i < ANCHOR_LOOKBACK; i--) {
    if (RULING_START.test(paras[i])) {
      start = i;
      break;
    }
  }

  if (start < 0) {
    start = end;
    let total = paras[end].length;
    while (start > 0 && total < FALLBACK_MIN_CHARS && end - start < FALLBACK_MAX_PARAS - 1) {
      start--;
      total += paras[start].length;
    }
  }

  const text = paras
    .slice(start, end + 1)
    .map((p) => p.replace(/^-\s*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length >= 40 ? text : null;
}

export type SanctionKind =
  | "idari-para-cezasi"
  | "talimat"
  | "ret"
  | "islem-yok"
  | "hatirlatma";

export type Sanction = {
  /** UI'da badge olarak gosterilen kisa etiket. */
  label: string;
  kind: SanctionKind;
  /** Idari para cezasi tutari (TL), yakalanabildiyse. */
  amountTry: number | null;
};

/**
 * Yaptirim sinifi kalibi, EN AGIRDAN HAFIFE dogru siralanmis.
 *
 * Sira onemli: bir hukum blogu birden fazla yaptirim tasiyabiliyor (or. bir
 * konuda para cezasi + baska bir konuda hatirlatma). Ilk eslesen kazanir.
 */
const SANCTION_RULES: { kind: SanctionKind; label: string; re: RegExp }[] = [
  // idari-para-cezasi ayri ele aliniyor (tutar ayikilamasi gerekiyor).
  {
    kind: "talimat",
    label: "Talimat verildi",
    re: /talimatlandırılmasına|talimat verilmesine|yönünde talimat|uyarılmasına/i,
  },
  {
    kind: "ret",
    label: "Talep reddedildi",
    re: /(şikâyet|şikayet|talebin|talebinin|başvurunun|itirazın)[^.]{0,40}reddine/i,
  },
  {
    kind: "islem-yok",
    label: "İşlem gerekmedi",
    // "...yapılacak bir işlem bulunmadığına" ve "...olmadığına" varyantlarinin
    // ikisi de kullaniliyor.
    re: /yapılacak bir işlem (?:bulunmadığ|olmadığ)|işlem yapılmasına (?:gerek|yer) (?:bulunmadığ|olmadığ)/i,
  },
  {
    kind: "hatirlatma",
    label: "Hatırlatma yapıldı",
    re: /hatırlatılmasına/i,
  },
];

/**
 * Turkce binlik ayraci nokta: "3.250.000" -> 3250000.
 * Ondalik virgul kullanildigi icin noktalari silmek guvenli.
 */
function parseTryAmount(raw: string): number | null {
  const n = Number(raw.replace(/\./g, "").replace(/,\d+$/, ""));
  // 1.000 TL alti / 100.000.000 TL ustu degerler kalip hatasi (madde no, yil vb.)
  return Number.isFinite(n) && n >= 1000 && n <= 100_000_000 ? n : null;
}

/**
 * Yaptirim etiketi — SADECE hukum blogundan cikarilir, govdenin tamamindan degil.
 *
 * Neden onemli: "idari para cezası", "şikâyetin reddine" gibi ifadeler kararin
 * anlati kisminda da geciyor (taraflarin iddialari, onceki Kurul kararlarina
 * atiflar, mevzuat alintilari). Govdenin tamamina bakmak yanlis etiket
 * uretiyordu.
 *
 * Tek etiket donuyor; bir kararda birden fazla yaptirim varsa en agir olan
 * kazanir (para cezasi > talimat > ret > islem yok).
 */
export function extractSanction(body: string): Sanction | null {
  const ruling = extractRuling(body);
  if (!ruling) return null;

  if (/idari para cezası/i.test(ruling)) {
    // Tutar "250.000 TL idari para cezası" ya da "idari para cezası ... 250.000 TL"
    // siralamasinda gelebiliyor; ikisini de dene, sonra blok icinde herhangi bir tutar.
    const m =
      ruling.match(/([\d][\d.]{3,})\s*(?:TL|Türk Lirası)[^.]{0,80}idari para cezası/i) ??
      ruling.match(/idari para cezası[^.]{0,140}?([\d][\d.]{3,})\s*(?:TL|Türk Lirası)/i) ??
      ruling.match(/([\d][\d.]{3,})\s*(?:TL|Türk Lirası)/i);
    const amountTry = m ? parseTryAmount(m[1]) : null;
    return {
      kind: "idari-para-cezasi",
      amountTry,
      label: amountTry
        ? `İdari para cezası · ${amountTry.toLocaleString("tr-TR")} TL`
        : "İdari para cezası",
    };
  }

  for (const rule of SANCTION_RULES) {
    if (rule.re.test(ruling)) {
      return { kind: rule.kind, amountTry: null, label: rule.label };
    }
  }

  return null;
}
