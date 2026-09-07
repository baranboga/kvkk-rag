"use client";

import { useCallback, useRef, useState } from "react";
import type { ChatSource } from "@/chat";

type Turn = {
  role: "user" | "assistant";
  content: string;
  /** Yalnizca assistant turlarinda: bu cevabin dayandigi kararlar. */
  sources?: ChatSource[];
  usage?: { promptTokens: number; completionTokens: number } | null;
};

const EXAMPLES = [
  "Çalışanların kurumsal e-postalarını izlemek hangi şartlarda hukuka aykırı sayılıyor?",
  "Fidye yazılımı saldırısında veri sorumlusunun sorumluluğu nasıl değerlendiriliyor?",
  "Açık rızayı hizmetin ön şartı yapmak neden geçersiz?",
];

export default function Chat({ enabled }: { enabled: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;

      setError(null);
      setInput("");
      setBusy(true);

      // Gecmisi LLM'e gonderirken UI'daki turlari kaynak olarak kullaniyoruz.
      const history: Turn[] = [...turns, { role: "user", content: q }];
      setTurns([...history, { role: "assistant", content: "" }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history.map((t) => ({ role: t.role, content: t.content })),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Analiz başarısız.");
        }

        // NDJSON: satir satir oku, yarim satiri tamponda tut.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const raw of lines) {
            if (!raw.trim()) continue;
            const evt = JSON.parse(raw) as
              | { type: "sources"; sources: ChatSource[] }
              | { type: "delta"; text: string }
              | { type: "done"; usage: Turn["usage"] }
              | { type: "error"; error: string };

            setTurns((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (!last || last.role !== "assistant") return prev;
              if (evt.type === "sources") next[next.length - 1] = { ...last, sources: evt.sources };
              else if (evt.type === "delta")
                next[next.length - 1] = { ...last, content: last.content + evt.text };
              else if (evt.type === "done")
                next[next.length - 1] = { ...last, usage: evt.usage };
              return next;
            });

            if (evt.type === "error") setError(evt.error);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
        // Bos assistant turunu birakma.
        setTurns((prev) =>
          prev.filter((t, i) => !(i === prev.length - 1 && t.role === "assistant" && !t.content))
        );
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, turns]
  );

  if (!enabled) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <p className="font-medium text-slate-800 dark:text-slate-200">Analiz devre dışı</p>
        <p className="mt-1">
          Bu bölüm kararları okuyup soruna cevap üretir ve tek ücretli bileşendir.
          Açmak için <code className="text-xs">.env</code> içine{" "}
          <code className="text-xs">OPENAI_API_KEY</code> ekle. Arama bu key olmadan
          da çalışır.
        </p>
      </div>
    );
  }

  return (
    <div>
      {turns.length === 0 && (
        <div className="mb-4">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Bir soru sor — sistem ilgili kararları bulur, sonra{" "}
            <strong className="font-semibold">yalnızca o kararlara dayanarak</strong>{" "}
            cevap üretir ve her iddiayı karar numarasıyla belgeler.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => void ask(ex)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-left text-sm text-slate-600
                           transition hover:border-sky-400 hover:text-sky-700
                           dark:border-slate-700 dark:text-slate-400 dark:hover:text-sky-400"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      <ol className="space-y-5">
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <li key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-sky-600 px-4 py-2.5 text-sm text-white">
                {turn.content}
              </p>
            </li>
          ) : (
            <li key={i}>
              <Answer turn={turn} streaming={busy && i === turns.length - 1} />
            </li>
          )
        )}
      </ol>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800
                     dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {error}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
        className="mt-5 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={turns.length ? "Devam sorusu sor…" : "Sorunu yaz…"}
          aria-label="Kararlar hakkında soru sor"
          className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none
                     transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-2
                     focus:ring-sky-500/20 dark:border-slate-700 dark:bg-slate-900"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-medium text-slate-600
                       hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Durdur
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-xl bg-sky-600 px-5 py-3 text-sm font-medium text-white transition
                       hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sor
          </button>
        )}
      </form>
    </div>
  );
}

function Answer({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const byKararNo = new Map(
    (turn.sources ?? []).filter((s) => s.kararNo).map((s) => [s.kararNo!, s])
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      {turn.content ? (
        <div className="space-y-2.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          {turn.content.split(/\n{2,}|\n(?=[-•*]\s)/).map((para, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {renderCitations(para, byKararNo)}
            </p>
          ))}
          {streaming && <span className="ml-0.5 inline-block animate-pulse">▌</span>}
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          {turn.sources ? "Kararlar okunuyor…" : "İlgili kararlar aranıyor…"}
        </p>
      )}

      {turn.sources && turn.sources.length > 0 && (
        <details className="group mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
          <summary className="cursor-pointer list-none text-xs font-medium text-slate-600 marker:content-none hover:text-sky-700 dark:text-slate-400 dark:hover:text-sky-400">
            <span className="inline-block transition-transform group-open:rotate-90">▸</span>{" "}
            Cevabın dayandığı {turn.sources.length} karar
          </summary>
          <ul className="mt-2 space-y-1.5">
            {turn.sources.map((s) => (
              <li key={s.url} className="text-xs leading-snug">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sky-700 hover:underline dark:text-sky-400"
                >
                  {s.kararNo ?? "no'suz"}
                </a>
                <span className="text-slate-400"> · {s.kararTarihi ?? "—"}</span>
                {s.sanctionLabel && (
                  <span className="text-slate-500 dark:text-slate-500"> · {s.sanctionLabel}</span>
                )}
                <span className="block text-slate-500 dark:text-slate-500">{s.konu}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {turn.usage && (
        <p className="mt-3 text-[11px] text-slate-400 dark:text-slate-600">
          {turn.usage.promptTokens.toLocaleString("tr-TR")} girdi +{" "}
          {turn.usage.completionTokens.toLocaleString("tr-TR")} çıktı token ·{" "}
          {formatCost(turn.usage)}
        </p>
      )}
    </div>
  );
}

/**
 * Model atiflari [2024/2196] biciminde yaziyor; bunlari kaynak listesindeki
 * karara baglayarak tiklanabilir hale getir. Kaynakta olmayan bir numara
 * uydurulmus olabilir — link YAPMA, isaretle ama metni de gizleme.
 *
 * Ayrica model markdown uretiyor (**kalin**); tam markdown parser'i getirmek
 * yerine yalnizca kalin isaretlemesi cozuluyor — cevaplarda pratikte baska
 * markdown kullanilmiyor ve ham `**` ekranda goruluyordu.
 */
function renderCitations(text: string, sources: Map<string, ChatSource>) {
  const CITATION = /(\[\d{4}\/\d+(?:[-\s,\d/]*)?\])/g;
  return text.split(CITATION).flatMap((part, i) => {
    const m = part.match(/^\[(\d{4}\/\d+)/);
    if (!m) return renderBold(part, `t${i}`);

    const src = sources.get(m[1]);
    if (!src) {
      return [
        <span
          key={`c${i}`}
          title="Bu karar numarası cevabın kaynakları arasında değil"
          className="rounded bg-amber-100 px-1 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-300"
        >
          {part}
        </span>,
      ];
    }
    return [
      <a
        key={`c${i}`}
        href={src.url}
        target="_blank"
        rel="noopener noreferrer"
        title={src.konu}
        className="rounded bg-sky-50 px-1 font-mono text-[11px] text-sky-700 hover:underline dark:bg-sky-950 dark:text-sky-300"
      >
        {m[1]}
      </a>,
    ];
  });
}

/** `**kalin**` -> <strong>. Akis sirasinda yarim kalan `**` oldugu gibi kalir. */
function renderBold(text: string, keyPrefix: string) {
  return text.split(/\*\*([^*]+)\*\*/g).map((seg, i) =>
    i % 2 === 1 ? (
      <strong key={`${keyPrefix}b${i}`} className="font-semibold text-slate-900 dark:text-slate-100">
        {seg}
      </strong>
    ) : (
      seg
    )
  );
}

// gpt-4.1 liste fiyati: 1M girdi token $2, 1M cikti token $8.
const USD_PER_INPUT_TOKEN = 2 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 8 / 1_000_000;

function formatCost(usage: { promptTokens: number; completionTokens: number }) {
  const usd =
    usage.promptTokens * USD_PER_INPUT_TOKEN +
    usage.completionTokens * USD_PER_OUTPUT_TOKEN;
  return `~$${usd.toFixed(4)}`;
}
