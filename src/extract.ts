/**
 * Karar govdesinden HUKUM ve YAPTIRIM cikarimi.
 *
 * Tamamen deterministik (regex) — LLM cagrisi yok, dolayisiyla maliyeti yok.
 * KVKK karar ozetleri tutarli bir kalip izliyor: metin "... karar verilmiştir."
 * ile biten bir hukum paragrafiyla kapaniyor. Olcum: 310 kararin 298'inde bu
 * kalip var (bkz. README "Hüküm ve yaptırım çıkarımı").
 */

/** Hukum paragrafini tanimlayan kalip. */
const RULING = /karar veril(?:miş|mesi)/i;

/**
 * Kararin hukum paragrafi: govdenin sonundan basa dogru "karar veril..."
 * iceren ILK paragraf.
 *
 * Neden sondan: uzun kararlarda gerekce kismi da onceki Kurul kararlarina atif
 * yaparken ayni ifadeyi kullaniyor ("...2019/81 sayili karar verilmistir").
 * Asil hukum her zaman metnin sonunda.
 */
export function extractRuling(body: string): string | null {
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim());
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i];
    if (!RULING.test(p)) continue;
    // Madde isareti ("- ") ile baslayan satirlar tek basina hukum degil,
    // hukum listesinin bir kalemi; yine de bilgi tasiyor, isareti kaldir.
    const clean = p.replace(/^-\s*/, "").trim();
    if (clean.length >= 40) return clean;
  }
  return null;
}

export type Sanction = {
  /** UI'da badge olarak gosterilen kisa etiket. */
  label: string;
  /** "idari-para-cezasi" | "talimat" | "islem-yok" | "diger" */
  kind: string;
  /** Idari para cezasi tutari (TL), yakalanabildiyse. */
  amountTry: number | null;
};

/**
 * Turkce binlik ayraci nokta: "3.250.000" -> 3250000.
 * Ondalik virgul kullanildigi icin noktalari silmek guvenli.
 */
function parseTryAmount(raw: string): number | null {
  const n = Number(raw.replace(/\./g, "").replace(/,\d+$/, ""));
  // 1.000 TL alti / 100.000.000 TL ustu degerler kalip hatasi (madde no, tarih vb.)
  return Number.isFinite(n) && n >= 1000 && n <= 100_000_000 ? n : null;
}

/**
 * Yaptirim etiketi. Sirala onemli: idari para cezasi en belirleyici sonuc,
 * onu talimat, sonra "islem yapilmasina gerek yok" izliyor.
 */
export function extractSanction(body: string): Sanction | null {
  if (/idari para cezası/i.test(body)) {
    // Tutar genellikle "... 250.000 TL idari para cezası" ya da
    // "idari para cezası ... 250.000 TL" siralamasinda geciyor; ikisini de dene.
    const near =
      body.match(/([\d][\d.]{3,})\s*(?:TL|Türk Lirası)[^.]{0,80}idari para cezası/i) ??
      body.match(/idari para cezası[^.]{0,120}?([\d][\d.]{3,})\s*(?:TL|Türk Lirası)/i) ??
      body.match(/([\d][\d.]{3,})\s*(?:TL|Türk Lirası)/i);
    const amountTry = near ? parseTryAmount(near[1]) : null;
    return {
      kind: "idari-para-cezasi",
      amountTry,
      label: amountTry
        ? `İdari para cezası · ${amountTry.toLocaleString("tr-TR")} TL`
        : "İdari para cezası",
    };
  }

  if (/talimatlandırılmasına|yönünde talimat/i.test(body)) {
    return { kind: "talimat", amountTry: null, label: "Talimat verildi" };
  }

  if (/yapılacak bir işlem bulunmadığ|işlem yapılmasına gerek/i.test(body)) {
    return { kind: "islem-yok", amountTry: null, label: "İşlem gerekmedi" };
  }

  if (/(şikâyet|şikayet|talebin|başvurunun)[^.]{0,40}reddine/i.test(body)) {
    return { kind: "ret", amountTry: null, label: "Talep reddedildi" };
  }

  return null;
}
