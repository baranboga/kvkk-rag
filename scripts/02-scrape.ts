/**
 * KVKK Kurul Karar Ozetleri'ni indirir -> data/decisions.json  (~36 sayfa)
 *
 * Yeniden kosulabilir: data/decisions.json'da olan id'ler tekrar indirilmez.
 * `--force` ile hepsi yeniden indirilir.
 *
 *   npm run scrape
 *   npm run scrape -- --force
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRAPE_DELAY_MS, SOURCES } from "../src/config";
import {
  crawlList,
  fetchDecision,
  type ListItem,
  type ScrapedDecision,
} from "../src/scrape/kvkk";

const DATA_DIR = join(process.cwd(), "data");
const OUT = join(DATA_DIR, "decisions.json");
const REPORT = join(DATA_DIR, "scrape-report.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const force = process.argv.includes("--force");
  mkdirSync(DATA_DIR, { recursive: true });

  const existing: ScrapedDecision[] =
    !force && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const known = new Map(existing.map((d) => [d.id, d]));
  if (known.size) console.log(`Onbellek: ${known.size} karar zaten indirilmis.\n`);

  // --- 1) Liste sayfalari ---
  console.log("1) Liste sayfalari geziliyor...");
  const items = new Map<string, ListItem>();
  for (const source of SOURCES) {
    console.log(`   [${source.key}] ${source.path}`);
    const found = await crawlList(source.key, source.path, (page, lastPage, n) => {
      process.stdout.write(`\r     sayfa ${page}/${lastPage} — ${n} kayit   `);
    });
    // Ayni karar iki listede de gecerse ilk kulliyat kazanir.
    for (const it of found) if (!items.has(it.id)) items.set(it.id, it);
    console.log(`\r     ${found.length} kayit                    `);
  }
  console.log(`   toplam ${items.size} benzersiz link\n`);

  // --- 2) Detay sayfalari ---
  const todo = [...items.values()].filter((i) => !known.has(i.id));
  console.log(`2) Detaylar indiriliyor (${todo.length} yeni)...`);

  const failed: { url: string; source: string; reason: string }[] = [];
  for (let i = 0; i < todo.length; i++) {
    const item = todo[i];
    try {
      const decision = await fetchDecision(item);
      if (decision) known.set(decision.id, decision);
      else
        failed.push({
          url: item.url,
          source: item.source,
          reason: "parse edilemedi (sayfa yok ya da govde bos)",
        });
    } catch (err) {
      failed.push({ url: item.url, source: item.source, reason: (err as Error).message });
    }
    process.stdout.write(
      `\r   ${i + 1}/${todo.length} — ${known.size} kayit, ${failed.length} hata   `
    );
    // Her 25 kayitta diske yaz: kosu yarida kalirsa is kaybolmasin.
    if ((i + 1) % 25 === 0) writeFileSync(OUT, JSON.stringify([...known.values()], null, 1));
    if (i < todo.length - 1) await sleep(SCRAPE_DELAY_MS);
  }

  // --- 3) Rapor ---
  const all = [...known.values()].sort((a, b) =>
    (b.kararTarihi ?? "").localeCompare(a.kararTarihi ?? "")
  );
  writeFileSync(OUT, JSON.stringify(all, null, 1));

  // Ayni karar no iki kez gelirse embed asamasinda unique index patlar; simdi yakala.
  const byKararNo = new Map<string, string[]>();
  for (const d of all) {
    if (!d.kararNo) continue;
    byKararNo.set(d.kararNo, [...(byKararNo.get(d.kararNo) ?? []), d.id]);
  }
  const duplicates = [...byKararNo.entries()].filter(([, ids]) => ids.length > 1);

  const years = all.map((d) => d.year).filter((y): y is number => y !== null);
  const chars = all.reduce((s, d) => s + d.charCount, 0);
  const perSource = SOURCES.map((s) => ({
    key: s.key,
    count: all.filter((d) => d.source === s.key).length,
  }));

  const report = {
    scrapedAt: new Date().toISOString(),
    listLinks: items.size,
    decisions: all.length,
    perSource,
    withKararNo: all.filter((d) => d.kararNo).length,
    withKararTarihi: all.filter((d) => d.kararTarihi).length,
    yearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
    totalChars: chars,
    avgChars: all.length ? Math.round(chars / all.length) : 0,
    metaKeys: [...new Set(all.flatMap((d) => Object.keys(d.meta)))],
    duplicateKararNo: duplicates,
    failed,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log(`\n\n=== Scrape ozeti ===`);
  console.log(`karar sayisi   : ${report.decisions} / ${report.listLinks} link`);
  for (const s of perSource) console.log(`  ${s.key.padEnd(13)}: ${s.count}`);
  console.log(`karar no       : ${report.withKararNo} kayitta var`);
  console.log(`karar tarihi   : ${report.withKararTarihi} kayitta var`);
  console.log(`yil araligi    : ${report.yearRange?.join(" – ") ?? "-"}`);
  console.log(`ortalama uzunluk: ${report.avgChars} karakter`);
  console.log(`meta alanlari  : ${report.metaKeys.join(", ")}`);
  if (duplicates.length) {
    console.log(`\n! ayni karar no birden fazla kayitta:`);
    for (const [no, ids] of duplicates) console.log(`  ${no} -> ${ids.join(", ")}`);
  }
  if (failed.length) {
    console.log(`\n${failed.length} basarisiz (data/scrape-report.json icinde):`);
    for (const f of failed.slice(0, 12)) console.log(`  - [${f.source}] ${f.url}`);
  }
  console.log(`\n-> ${OUT}`);
  console.log("\nSirada: npm run embed\n");
}

main().catch((err) => {
  console.error("\nScrape basarisiz:", err);
  process.exit(1);
});
