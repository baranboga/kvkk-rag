// SADECE SERVER — OpenAI key'i kullanir; bkz. src/search/hybrid.ts basindaki not.
import OpenAI from "openai";
import { optionalEnv, requireEnv } from "./env";
import { hybridSearch, type SearchHit } from "./search/hybrid";

export const CHAT_MODEL = optionalEnv("OPENAI_CHAT_MODEL", "gpt-4.1");

/** Cevap uretimi icin LLM'e verilen karar sayisi. */
const CONTEXT_HITS = 6;
/** Bir kararin baglama giren pasaj uzunlugu ust siniri (karakter). */
const MAX_PASSAGE_CHARS = 1400;
/** Sohbet gecmisinden LLM'e tasinan son mesaj sayisi (soru + cevap ciftleri). */
const HISTORY_TURNS = 6;

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** LLM'e gonderilen kaynak; UI'da atif linkine cevrilir. */
export type ChatSource = {
  kararNo: string | null;
  kararTarihi: string | null;
  konu: string;
  url: string;
  sanctionLabel: string | null;
};

const SYSTEM_PROMPT = `Sen KVKK (Kişisel Verileri Koruma Kurumu) kurul kararları üzerinde çalışan bir hukuk asistanısın.

GÖREVİN: Kullanıcının sorusunu, SANA VERİLEN kurul kararlarına dayanarak yanıtla.

KURALLAR:
1. YALNIZCA sana verilen kararlardaki bilgiyi kullan. Kararlarda olmayan bir şeyi ekleme, genel hukuk bilgisinden tamamlama yapma.
2. Her somut iddiayı, dayandığı kararın numarasıyla köşeli parantez içinde belirt: [2024/2196]. Birden fazla karara dayanıyorsa hepsini yaz: [2024/2196][2022/711].
   Karar numarası "(numarasız)" olarak verilmiş bir karara ASLA köşeli parantezli atıf yazma — onu cümle içinde tarihi ve konusuyla an (örn. "07.11.2024 tarihli, güvenlik kamerası kaydına ilişkin kararda...").
3. Verilen kararlar soruyu yanıtlamaya yetmiyorsa bunu AÇIKÇA söyle. Uydurma.
4. Kararlar arasında çelişki veya farklı yaklaşım varsa bunu belirt.
5. Para cezası tutarları, tarihler ve karar numaralarını asla değiştirme; verildiği gibi aktar.
6. Türkçe, açık ve öz yaz. Gerektiğinde kısa maddeler kullan. Gereksiz giriş cümlesi kurma.
7. Sen avukat değilsin ve bu bir hukuki mütalaa değil. Kullanıcı bir eylem planı isterse, kararlardan çıkan ölçütleri aktar ama "hukuki tavsiye" verme.`;

/** Kararlari LLM baglamina cevirir. */
function buildContext(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const passage = (h.highlighted ?? h.snippet)
        .replace(/<\/?mark>/g, "")
        .slice(0, MAX_PASSAGE_CHARS);
      const lines = [
        `### Karar ${i + 1}`,
        // Numarasiz kararlar (310'un 11'i) parantezli atifa uygun degil;
        // sistem prompt'u modele bunlari cumle icinde anmasini soyluyor.
        `Karar No: ${h.kararNo ?? "(numarasız)"}`,
        `Karar Tarihi: ${h.kararTarihi ?? "(belirtilmemiş)"}`,
        `Konu: ${h.konuOzeti ?? h.title}`,
      ];
      if (h.sanctionLabel) lines.push(`Sonuç: ${h.sanctionLabel}`);
      lines.push(`İlgili pasaj: ${passage}`);
      if (h.ruling) lines.push(`Kararın hükmü: ${h.ruling.slice(0, MAX_PASSAGE_CHARS)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

const toSource = (h: SearchHit): ChatSource => ({
  kararNo: h.kararNo,
  kararTarihi: h.kararTarihi,
  konu: h.konuOzeti ?? h.title,
  url: h.url,
  sanctionLabel: h.sanctionLabel,
});

export type ChatRun = {
  sources: ChatSource[];
  /** Cevap parcalari. */
  stream: AsyncIterable<string>;
  /** Akis bittikten sonra token kullanimini verir. */
  usage: () => { promptTokens: number; completionTokens: number } | null;
};

/**
 * Retrieval + cevap uretimi.
 *
 * Her turda SON kullanici mesaji icin yeniden arama yapilir (sohbet ilerledikce
 * konu kaydigi icin ilk turun baglamiyla devam etmek yanlis sonuc veriyor).
 * Onceki mesajlar modele gecmis olarak verilir ama onlarin baglami tekrar
 * gonderilmez — token maliyeti turla birlikte buyumesin.
 */
export async function runChat(messages: ChatMessage[]): Promise<ChatRun> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) throw new Error("Kullanici mesaji yok.");

  const search = await hybridSearch(lastUser.content, CONTEXT_HITS);
  const sources = search.hits.map(toSource);

  const client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

  const history = messages
    .slice(-HISTORY_TURNS - 1, -1)
    .map((m) => ({ role: m.role, content: m.content }));

  const context =
    search.hits.length > 0
      ? buildContext(search.hits)
      : "(Arama bu soru için ilgili karar bulamadı.)";

  const completion = await client.chat.completions.create({
    model: CHAT_MODEL,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2, // hukuki metinde tutarlilik > yaraticilik
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      {
        role: "user",
        content: `Aşağıda, sorumla ilgili olarak veritabanından getirilen KVKK kurul kararları var.\n\n${context}\n\n---\n\nSORUM: ${lastUser.content}`,
      },
    ],
  });

  let usage: { promptTokens: number; completionTokens: number } | null = null;

  async function* iterate() {
    for await (const chunk of completion) {
      // include_usage ile son chunk yalnizca usage tasir, choices bos gelir.
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  return { sources, stream: iterate(), usage: () => usage };
}
