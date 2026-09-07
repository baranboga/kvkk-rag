import {
  HF_EMBEDDING_DIM,
  HF_EMBEDDING_MODEL,
  HF_PASSAGE_PREFIX,
  HF_QUERY_PREFIX,
} from "../config";
import { requireEnv } from "../env";

const ROUTER = `https://router.huggingface.co/hf-inference/models/${HF_EMBEDDING_MODEL}/pipeline/feature-extraction`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function meanPool(tokens: number[][]): number[] {
  const dim = tokens[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const t of tokens) for (let i = 0; i < dim; i++) out[i] += t[i];
  for (let i = 0; i < dim; i++) out[i] /= tokens.length;
  return out;
}

/**
 * HF feature-extraction ciktisinin sekli modele gore degisiyor:
 * sentence-transformers modelleri pooled 2B doner, ham BERT'ler token seviyesi
 * 3B (ya da tek input icin 2B) doner. Hepsini "input basina bir vektor"e indir.
 */
function normalizeVectors(data: unknown, inputCount: number): number[][] {
  const arr = data as number[] | number[][] | number[][][];
  if (typeof (arr as number[])[0] === "number") {
    return [arr as number[]];
  }
  const two = arr as number[][];
  if (typeof (two[0] as unknown as number[])[0] === "number") {
    if (inputCount === 1) {
      if (two.length === 1 && two[0].length === HF_EMBEDDING_DIM) return two;
      return [meanPool(two)]; // tek input, token embedding'leri
    }
    return two;
  }
  return (arr as number[][][]).map(meanPool);
}

async function featureExtraction(inputs: string[], attempt = 0): Promise<number[][]> {
  const res = await fetch(ROUTER, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("HF_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs,
      // 512 token siniri asilirsa hata yerine kesme istiyoruz.
      options: { wait_for_model: true },
      truncate: true,
    }),
  });

  // 503 = model yukleniyor, 429 = rate limit, 5xx = gecici. Backoff ile tekrar dene.
  if ((res.status === 503 || res.status === 429 || res.status >= 500) && attempt < 6) {
    const wait = Math.min(2000 * 2 ** attempt, 30_000);
    await sleep(wait);
    return featureExtraction(inputs, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`HF feature-extraction ${res.status}: ${await res.text()}`);
  }

  const vectors = normalizeVectors(await res.json(), inputs.length);
  if (vectors.length !== inputs.length) {
    throw new Error(
      `HF ${inputs.length} input icin ${vectors.length} vektor dondu (model: ${HF_EMBEDDING_MODEL}).`
    );
  }
  for (const v of vectors) {
    if (v.length !== HF_EMBEDDING_DIM) {
      throw new Error(
        `HF vektor boyutu ${v.length}, beklenen ${HF_EMBEDDING_DIM}. ` +
          `.env icindeki HF_EMBEDDING_DIM ile model uyusmuyor (model: ${HF_EMBEDDING_MODEL}).`
      );
    }
  }
  return vectors;
}

/** Dokuman/chunk tarafi: E5 "passage: " prefix'i ile embed et. */
export function embedPassages(texts: string[]): Promise<number[][]> {
  return featureExtraction(texts.map((t) => HF_PASSAGE_PREFIX + t));
}

/** Arama tarafi: E5 "query: " prefix'i ile tek vektor dondur. */
export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await featureExtraction([HF_QUERY_PREFIX + text]);
  return v;
}

/** pgvector'un bekledigi literal format: "[0.1,0.2,...]". */
export const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;
