import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireEnv } from "../env";
import * as schema from "./schema";

/**
 * Uygulama + script sorgulari: Supabase transaction pooler (port 6543).
 *
 * Pooler prepared statement DESTEKLEMEZ -> `prepare: false` zorunlu. Bunu
 * atlarsan sorgular anlasilmaz hatalarla patlar.
 *
 * DDL/migration bu client'i kullanmaz; onlar DIRECT_URL (5432) uzerinden gider
 * (bkz. src/db/direct.ts).
 */
const queryClient = postgres(requireEnv("DATABASE_URL"), {
  prepare: false,
  max: 5,
});

export const db = drizzle(queryClient, { schema });
export { queryClient };
