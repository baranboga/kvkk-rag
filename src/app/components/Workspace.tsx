"use client";

import { useState } from "react";
import Chat from "./Chat";
import SearchBar from "./SearchBar";

type Tab = "arama" | "analiz";

type Props = {
  yearMin: number | null;
  yearMax: number | null;
  chatEnabled: boolean;
};

/**
 * Iki mod tek sayfada:
 *  - Arama : ucretsiz retrieval, kararlari listeler
 *  - Analiz: ayni retrieval + LLM cevabi (tek ucretli bilesen)
 *
 * Sekmeler mount edilmis kalir (gizlenir, kaldirilmaz) — kullanici sekme
 * degistirdiginde arama sonuclari ve sohbet gecmisi kaybolmasin.
 */
export default function Workspace({ yearMin, yearMax, chatEnabled }: Props) {
  const [tab, setTab] = useState<Tab>("arama");

  return (
    <div>
      <div
        role="tablist"
        aria-label="Çalışma modu"
        className="mb-5 inline-flex rounded-xl border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-900"
      >
        <TabButton active={tab === "arama"} onClick={() => setTab("arama")}>
          Arama
        </TabButton>
        <TabButton active={tab === "analiz"} onClick={() => setTab("analiz")}>
          Analiz
          <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
            ücretli
          </span>
        </TabButton>
      </div>

      <div role="tabpanel" hidden={tab !== "arama"}>
        <SearchBar yearMin={yearMin} yearMax={yearMax} ready />
      </div>
      <div role="tabpanel" hidden={tab !== "analiz"}>
        <Chat enabled={chatEnabled} />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-sky-600 text-white"
          : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {children}
    </button>
  );
}
