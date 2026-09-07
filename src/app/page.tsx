import Workspace from "./components/Workspace";
import { HF_EMBEDDING_DIM, HF_EMBEDDING_MODEL } from "@/config";
import { getCorpusStats } from "@/corpus";

/**
 * Korpus istatistikleri DB'den geliyor ve indeks guncellendikce degisiyor.
 * force-dynamic olmadan Next bu sayfayi build aninda prerender edip sayilari
 * dondururdu (ve build makinesinde DB erisimi gerektirirdi).
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const stats = await getCorpusStats();

  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-sky-700 dark:text-sky-400">
          Kişisel Verileri Koruma Kurumu
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Kurul Kararlarında Semantik Arama
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Kurul karar özetlerinde <strong className="font-semibold">anlam tabanlı</strong>{" "}
          arama. Kararın içinde geçen kelimeyi bilmene gerek yok — ne aradığını
          gündelik dille yaz.
        </p>
      </header>

      <section className="mt-8">
        {stats.ready ? (
          <Workspace
            yearMin={stats.yearMin}
            yearMax={stats.yearMax}
            // Key'in kendisi ASLA client'a gecmez; yalnizca var/yok bilgisi.
            chatEnabled={Boolean(process.env.OPENAI_API_KEY)}
          />
        ) : (
          <NotIndexed />
        )}
      </section>

      <footer className="mt-14 border-t border-slate-200 pt-5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-500">
        <dl className="flex flex-wrap gap-x-6 gap-y-1.5">
          <Stat label="İndekslenen karar" value={stats.decisions.toLocaleString("tr-TR")} />
          <Stat label="Pasaj (chunk)" value={stats.embedded.toLocaleString("tr-TR")} />
          {stats.yearMin && stats.yearMax && (
            <Stat label="Yıl aralığı" value={`${stats.yearMin}–${stats.yearMax}`} />
          )}
          <Stat label="Embedding" value={`${HF_EMBEDDING_MODEL} · ${HF_EMBEDDING_DIM}d`} />
          <Stat label="Arama" value="pgvector HNSW + Türkçe full-text (RRF)" />
          {process.env.OPENAI_API_KEY && (
            <Stat label="Analiz" value={process.env.OPENAI_CHAT_MODEL ?? "gpt-4.1"} />
          )}
        </dl>
        <p className="mt-4">
          Kaynak:{" "}
          <a
            href="https://www.kvkk.gov.tr/Icerik/5406/kurul-karar-ozetleri"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-700 hover:underline dark:text-sky-400"
          >
            kvkk.gov.tr — Kurul Karar Özetleri
          </a>
          . Bu bir resmî yayın değildir; bağlayıcı metin için kaynak sayfayı esas al.
        </p>
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-slate-400 dark:text-slate-600">{label}: </dt>
      <dd className="inline font-medium text-slate-700 dark:text-slate-300">{value}</dd>
    </div>
  );
}

function NotIndexed() {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm dark:border-amber-900 dark:bg-amber-950/30">
      <p className="font-semibold text-amber-900 dark:text-amber-200">
        İndeks henüz hazır değil.
      </p>
      <p className="mt-1 text-amber-800 dark:text-amber-300">
        Aramanın çalışması için veri hattını sırayla çalıştır:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-amber-900/90 p-3 text-xs leading-relaxed text-amber-50">
        {`npm run verify:db
npm run db:migrate
npm run scrape
npm run embed
npm run db:index`}
      </pre>
    </div>
  );
}
