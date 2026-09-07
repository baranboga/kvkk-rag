"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchHit, SearchResponse } from "@/search/hybrid";

const EXAMPLES = [
  "güvenlik kamerası ile ses kaydı alınması",
  "fidye yazılımı saldırısı sonucu veri ihlali",
  "izinsiz reklam SMS'i gönderilmesi",
  "çalışanın özlük dosyasındaki sağlık verileri",
  "açık rıza hizmetin ön şartı yapılamaz",
  "yurt dışına veri aktarımı",
];

type Props = {
  yearMin: number | null;
  yearMax: number | null;
  ready: boolean;
};

export default function SearchBar({ yearMin, yearMax, ready }: Props) {
  const [query, setQuery] = useState("");
  const [yearGte, setYearGte] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Kullanici hizli hizli arama yaparsa geciken eski cevabin yenisini ezmesini engelle.
  const requestId = useRef(0);

  const run = useCallback(
    async (q: string, gte: string) => {
      const text = q.trim();
      if (!text) return;
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q: text, limit: "10" });
        if (gte) params.set("yearGte", gte);
        const res = await fetch(`/api/search?${params}`);
        const data = await res.json();
        if (id !== requestId.current) return;
        if (!res.ok) {
          setError(data.error ?? "Arama başarısız.");
          setResult(null);
        } else {
          setResult(data as SearchResponse);
        }
      } catch {
        if (id === requestId.current) setError("Sunucuya ulaşılamadı.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const years: number[] = [];
  if (yearMin && yearMax) {
    for (let y = yearMax; y >= yearMin; y--) years.push(y);
  }

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query, yearGte);
        }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ne arıyorsun? Örn: biyometrik veriyle mesai takibi"
            aria-label="Kurul kararlarında ara"
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 pr-11 text-base
                       shadow-sm outline-none transition placeholder:text-slate-400
                       focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20
                       dark:border-slate-700 dark:bg-slate-900 dark:placeholder:text-slate-500"
          />
          {loading && (
            <span
              aria-hidden
              className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin
                         rounded-full border-2 border-slate-300 border-t-sky-500"
            />
          )}
        </div>

        {years.length > 0 && (
          <select
            value={yearGte}
            onChange={(e) => {
              setYearGte(e.target.value);
              if (query.trim()) void run(query, e.target.value);
            }}
            aria-label="En eski karar yılı"
            className="rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm
                       outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Tüm yıllar</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y} ve sonrası
              </option>
            ))}
          </select>
        )}

        <button
          type="submit"
          disabled={loading || !query.trim() || !ready}
          className="rounded-xl bg-sky-600 px-6 py-3 font-medium text-white shadow-sm transition
                     hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500/40
                     disabled:cursor-not-allowed disabled:opacity-40"
        >
          Ara
        </button>
      </form>

      {!result && !error && (
        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setQuery(ex);
                void run(ex, yearGte);
              }}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-600
                         transition hover:border-sky-400 hover:text-sky-700
                         dark:border-slate-700 dark:text-slate-400 dark:hover:text-sky-400"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800
                     dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {error}
        </p>
      )}

      {result && <Results result={result} />}
    </div>
  );
}

function Results({ result }: { result: SearchResponse }) {
  if (result.hits.length === 0) {
    return (
      <div className="mt-8 rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
        <p className="font-medium text-slate-700 dark:text-slate-300">Sonuç bulunamadı.</p>
        <p className="mt-1">Daha genel bir ifade dene ya da yıl filtresini kaldır.</p>
      </div>
    );
  }

  return (
    <>
      <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">
        <strong className="font-semibold text-slate-700 dark:text-slate-300">
          {result.hits.length}
        </strong>{" "}
        karar · {result.counts.fused} aday karardan seçildi ·{" "}
        {result.counts.vector} vektör + {result.counts.keyword} terim eşleşmesi ·
        embedding {result.timings.embedMs} ms, arama {result.timings.retrieveMs} ms
      </p>

      <ol className="mt-4 space-y-4">
        {result.hits.map((hit, i) => (
          <ResultCard key={hit.decisionId} hit={hit} rank={i + 1} />
        ))}
      </ol>
    </>
  );
}

function ResultCard({ hit, rank }: { hit: SearchHit; rank: number }) {
  const passage = hit.highlighted ?? truncate(hit.snippet, 420);

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">#{rank}</span>
        {/* Karar no eski format bazi karar sayfalarinda hic gecmiyor. */}
        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {hit.kararNo ?? "no'suz"}
        </span>
        {hit.kararTarihi && (
          <span className="text-slate-500 dark:text-slate-400">
            {formatTrDate(hit.kararTarihi)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {hit.via.includes("vector") && <Badge tone="sky">anlam</Badge>}
          {hit.via.includes("keyword") && <Badge tone="emerald">terim</Badge>}
          {hit.matchedChunks > 1 && (
            <span className="text-slate-400" title="Kararın kaç pasajı eşleşti">
              {hit.matchedChunks} pasaj
            </span>
          )}
        </span>
      </div>

      <h2 className="mt-2 text-sm font-semibold leading-snug text-slate-900 dark:text-slate-100">
        <a
          href={hit.url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-sky-700 hover:underline dark:hover:text-sky-400"
        >
          {hit.konuOzeti ?? hit.title}
        </a>
      </h2>

      {hit.sanctionLabel && (
        <p className="mt-2">
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-medium ${
              SANCTION_TONE[hit.sanctionKind ?? ""] ??
              "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {hit.sanctionLabel}
          </span>
        </p>
      )}

      <p
        className="passage mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400"
        // ts_headline yalnizca <mark> uretir; icerik kendi veritabanimizdan geliyor.
        dangerouslySetInnerHTML={{ __html: passage }}
      />

      {hit.ruling && (
        <details className="group mt-3 rounded-lg border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/40">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-slate-700 marker:content-none hover:text-sky-700 dark:text-slate-300 dark:hover:text-sky-400">
            <span className="inline-block transition-transform group-open:rotate-90">▸</span>{" "}
            Kararın hükmü
            {hit.sanctionLabel && (
              <span className="ml-1 font-normal text-slate-500 dark:text-slate-500">
                — {hit.sanctionLabel}
              </span>
            )}
          </summary>
          <p className="border-t border-slate-200 px-3 py-2.5 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:text-slate-400">
            {hit.ruling}
          </p>
        </details>
      )}

      <a
        href={hit.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-block text-xs text-sky-700 hover:underline dark:text-sky-400"
      >
        kvkk.gov.tr üzerinde tam kararı gör →
      </a>
    </li>
  );
}

/** Yaptirim turune gore renk: para cezasi vurgulu, olumsuz sonuclar notr. */
const SANCTION_TONE: Record<string, string> = {
  "idari-para-cezasi": "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  talimat: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  ret: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  "islem-yok": "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  hatirlatma: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

function Badge({ tone, children }: { tone: "sky" | "emerald"; children: React.ReactNode }) {
  const tones = {
    sky: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  } as const;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

function formatTrDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
