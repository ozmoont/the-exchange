import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

/**
 * Lazy DB client.
 *
 * IMPORTANT: never throw or open a connection at module load. Next.js
 * imports every server-side module during `next build` to collect exports
 * for code splitting and route discovery — if this file errored at import
 * time (because DATABASE_URL isn't available at build), the entire build
 * would fail before any request runs.
 *
 * Instead we wrap the drizzle instance in a Proxy. Module load is a no-op
 * (no env check, no connection). The connection is created on the first
 * query and reused across the process. If DATABASE_URL is missing when a
 * query is actually attempted, we throw with a clear message at that
 * point — which surfaces in request logs, not in the build step.
 *
 * This pattern also plays nicely with Vercel "Sensitive" env vars that
 * are only exposed at runtime, not at build.
 */

type Schema = typeof schema;
type DrizzleDb = ReturnType<typeof drizzle<Schema>>;

let _sql: ReturnType<typeof postgres> | undefined;
let _db: DrizzleDb | undefined;

function init(): DrizzleDb {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. This was caught at first query — the module " +
        "itself loads cleanly so the build can succeed. Set DATABASE_URL in " +
        "the runtime environment (Vercel project env vars or .env.local).",
    );
  }
  _sql = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  _db = drizzle(_sql, { schema });
  return _db;
}

export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Reflect.get(init() as any, prop);
  },
}) as DrizzleDb;

export { schema };
