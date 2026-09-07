import "dotenv/config";
import postgres from "postgres";
import { requireEnv } from "../env";

/**
 * DDL icin direct baglanti (port 5432). CREATE EXTENSION / CREATE INDEX gibi
 * islemler pooler uzerinden guvenilir calismaz.
 *
 * Cagiran taraf isi bitince `.end()` cagirmali.
 */
export function directClient() {
  return postgres(requireEnv("DIRECT_URL"), { max: 1 });
}
