// SADECE SERVER — bkz. src/search/hybrid.ts basindaki not.
import { queryClient } from "./db/client";

export type CorpusStats = {
  decisions: number;
  chunks: number;
  embedded: number;
  yearMin: number | null;
  yearMax: number | null;
  ready: boolean;
};

/** Ana sayfada gosterilen indeks durumu. Indeks bossa UI kullaniciyi uyarir. */
export async function getCorpusStats(): Promise<CorpusStats> {
  try {
    const [row] = await queryClient<
      {
        decisions: number;
        chunks: number;
        embedded: number;
        year_min: number | null;
        year_max: number | null;
      }[]
    >`
      SELECT
        (SELECT count(*) FROM kvkk.decisions)::int AS decisions,
        (SELECT count(*) FROM kvkk.chunks)::int AS chunks,
        (SELECT count(*) FROM kvkk.chunks WHERE embedding IS NOT NULL)::int AS embedded,
        (SELECT min(year) FROM kvkk.decisions)::int AS year_min,
        (SELECT max(year) FROM kvkk.decisions)::int AS year_max
    `;
    return {
      decisions: row.decisions,
      chunks: row.chunks,
      embedded: row.embedded,
      yearMin: row.year_min,
      yearMax: row.year_max,
      ready: row.embedded > 0,
    };
  } catch {
    // Sema henuz kurulmamis olabilir — UI'i patlatmak yerine "hazir degil" don.
    return {
      decisions: 0,
      chunks: 0,
      embedded: 0,
      yearMin: null,
      yearMax: null,
      ready: false,
    };
  }
}
