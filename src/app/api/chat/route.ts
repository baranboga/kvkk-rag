import { runChat, type ChatMessage } from "@/chat";

/**
 * Cevap uretimi endpoint'i (NDJSON akisi).
 *
 * Satir bicimleri:
 *   {"type":"sources","sources":[...]}   -> ilk satir, kaynaklar hemen gosterilebilsin
 *   {"type":"delta","text":"..."}        -> cevap parcalari
 *   {"type":"done","usage":{...}}        -> token kullanimi
 *   {"type":"error","error":"..."}       -> akis ortasinda hata
 *
 * Neden NDJSON: kaynaklari cevap uretilmeye baslamadan gonderebiliyoruz ve
 * sonda gercek token kullanimini iletebiliyoruz (maliyet UI'da gosteriliyor).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 2000;

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY tanımlı değil; analiz devre dışı." },
      { status: 503 }
    );
  }

  let messages: ChatMessage[];
  try {
    const body = (await request.json()) as { messages?: unknown };
    messages = normalizeMessages(body.messages);
  } catch {
    return Response.json({ error: "Geçersiz istek gövdesi." }, { status: 400 });
  }

  if (messages.length === 0) {
    return Response.json({ error: "Mesaj yok." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const line = (obj: unknown) => encoder.encode(`${JSON.stringify(obj)}\n`);

  try {
    const run = await runChat(messages);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(line({ type: "sources", sources: run.sources }));
        try {
          for await (const text of run.stream) {
            controller.enqueue(line({ type: "delta", text }));
          }
          controller.enqueue(line({ type: "done", usage: run.usage() }));
        } catch (err) {
          console.error("[chat] akis hatasi:", err);
          controller.enqueue(
            line({ type: "error", error: "Cevap üretilirken bağlantı kesildi." })
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[chat] basarisiz:", err);
    const message = (err as Error).message ?? "";
    const isRateLimit = /429|rate limit|quota/i.test(message);
    return Response.json(
      {
        error: isRateLimit
          ? "OpenAI kota/hız sınırına takıldı. Birkaç saniye sonra tekrar dene."
          : "Analiz sırasında bir hata oluştu.",
        detail: message,
      },
      { status: isRateLimit ? 429 : 500 }
    );
  }
}

function normalizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error("messages dizi degil");
  return raw
    .slice(-MAX_MESSAGES)
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        (m as ChatMessage).role !== undefined &&
        ["user", "assistant"].includes((m as ChatMessage).role) &&
        typeof (m as ChatMessage).content === "string" &&
        (m as ChatMessage).content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT_CHARS) }));
}
