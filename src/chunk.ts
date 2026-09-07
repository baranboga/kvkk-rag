import {
  CHUNK_MIN_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
} from "./config";

export type TextChunk = {
  index: number;
  text: string;
  tokenEstimate: number;
};

/** Turkce'de multilingual E5 tokenizer'i kabaca 3 karakter/token uretiyor. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

/**
 * Metni once paragraflara, gerekirse cumlelere bolerek CHUNK_TARGET_CHARS
 * civarinda parcalar uretir.
 *
 * Neden cumle sinirinda: kararlar "...12 nci maddesinin (1) numarali fikrasinda
 * yer alan yukumlulugu" gibi tek cumlede tasinan hukuki gerekceler iceriyor.
 * Sabit karakter penceresi bunlari ortadan keserse chunk anlamsizlasir ve
 * embedding kalitesi duser.
 *
 * Overlap, sinira denk gelen bir gerekcenin iki chunk'ta da tam gorunmesini
 * saglar.
 */
export function chunkText(raw: string): TextChunk[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Hedeften buyuk paragraflari cumlelere ac.
  const units: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_TARGET_CHARS) {
      units.push(p);
      continue;
    }
    for (const s of splitSentences(p)) {
      // Tek cumle bile hedeften buyukse sert kes; alternatifi yok.
      if (s.length <= CHUNK_TARGET_CHARS) units.push(s);
      else for (let i = 0; i < s.length; i += CHUNK_TARGET_CHARS)
        units.push(s.slice(i, i + CHUNK_TARGET_CHARS));
    }
  }

  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= CHUNK_TARGET_CHARS) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = `${tailOverlap(current)}${unit}`;
      // Overlap + yeni birim hedefi asabilir; asiyorsa overlap'i birak.
      if (current.length > CHUNK_TARGET_CHARS * 1.3) current = unit;
    } else {
      current = unit;
    }
  }
  if (current) chunks.push(current);

  // Cok kisa son parca varsa oncekine yapistir — tek basina arama degeri yok.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < CHUNK_MIN_CHARS) {
    const tail = chunks.pop()!;
    chunks[chunks.length - 1] += `\n\n${tail}`;
  }

  return chunks.map((t, index) => ({
    index,
    text: t.trim(),
    tokenEstimate: estimateTokens(t),
  }));
}

/** Onceki chunk'in son cumlelerinden ~CHUNK_OVERLAP_CHARS kadarini dondurur. */
function tailOverlap(chunk: string): string {
  if (CHUNK_OVERLAP_CHARS <= 0) return "";
  const tail = chunk.slice(-CHUNK_OVERLAP_CHARS);
  // Kelime ortasindan baslamamak icin ilk bosluktan sonrasini al.
  const cut = tail.indexOf(" ");
  const clean = (cut > 0 ? tail.slice(cut + 1) : tail).trim();
  return clean ? `${clean}\n\n` : "";
}

/**
 * Turkce cumle bolme. Kisaltma ve numaralandirma tuzaklarini elle geciyoruz:
 * "md.", "s.", "No.", "12 nci", "(1)" gibi kaliplar noktali ama cumle sonu degil.
 */
function splitSentences(paragraph: string): string[] {
  const ABBREV = /(?:md|mad|bkz|s|sy|No|no|Nr|vb|vs|örn|ör|Sn|Av|Dr|Prof|Doç|T\.?C|A\.?Ş|Ltd|Şti)$/;

  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const next = paragraph[i + 1];
    // Cumle sonu icin noktalamadan sonra bosluk/son gerekir.
    if (next && next !== " " && next !== "\n") continue;

    const before = paragraph.slice(start, i);
    const lastWord = before.split(/[\s(]/).pop() ?? "";
    if (ch === "." && ABBREV.test(lastWord)) continue;
    // "2024." veya "12." gibi sira sayilari
    if (ch === "." && /^\d+$/.test(lastWord)) continue;

    const sentence = paragraph.slice(start, i + 1).trim();
    if (sentence) out.push(sentence);
    start = i + 1;
  }
  const rest = paragraph.slice(start).trim();
  if (rest) out.push(rest);
  return out.length ? out : [paragraph];
}
