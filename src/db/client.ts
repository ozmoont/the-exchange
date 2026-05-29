import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// postgres.js client. Works with any standard Postgres — local Docker, RDS,
// Supabase, Neon (in TCP mode), etc. If we ever go back to Neon's HTTP driver
// for serverless edge runtime support, swap to `drizzle-orm/neon-http` and
// `@neondatabase/serverless`.
const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sql, { schema });
export { schema };
