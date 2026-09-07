import { NextResponse } from "next/server";
import { hybridSearch } from "@/search/hybrid";

/**
 * Arama endpoint'i. HF token ve DB baglantisi yalnizca burada — tarayici
 * hicbir zaman ne HF'e ne Postgres'e dogrudan gitmiyor.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_CHARS = 500;
const MAX_LIMIT = 25;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("q") ?? "").slice(0, MAX_QUERY_CHARS).trim();

  if (!query) {
    return NextResponse.json({ error: "Sorgu bos." }, { status: 400 });
  }

  const limit = clampInt(searchParams.get("limit"), 10, 1, MAX_LIMIT);
  const yearGte = parseYear(searchParams.get("yearGte"));
  const yearLte = parseYear(searchParams.get("yearLte"));

  try {
    const result = await hybridSearch(query, limit, { yearGte, yearLte });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[search] basarisiz:", err);
    const message = (err as Error).message ?? "Bilinmeyen hata";
    // HF rate limit'i kullaniciya anlamli sekilde gecir.
    const isRateLimit = /429|rate limit/i.test(message);
    return NextResponse.json(
      {
        error: isRateLimit
          ? "Embedding servisi şu an yoğun (HF rate limit). Birkaç saniye sonra tekrar dene."
          : "Arama sırasında bir hata oluştu.",
        detail: message,
      },
      { status: isRateLimit ? 429 : 500 }
    );
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseYear(raw: string | null): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 2016 || n > 2100) return undefined;
  return Math.trunc(n);
}
