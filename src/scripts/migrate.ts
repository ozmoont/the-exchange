/**
 * Production migration runner.
 *
 * Replaces `drizzle-kit push` for production deploys. The push flow is
 * destructive — it diffs the live schema and applies whatever ALTERs it
 * thinks are needed, which can silently drop columns under strict mode.
 * This script runs versioned migration files in order and tracks what's
 * been applied via the `__drizzle_migrations` table (drizzle-orm/migrator
 * does the bookkeeping).
 *
 * Workflow:
 *   1. Edit src/db/schema.ts
 *   2. Run `pnpm db:generate` — drizzle-kit produces drizzle/<timestamp>_<name>.sql
 *   3. Review the SQL, commit it
 *   4. On deploy, Vercel runs `pnpm db:migrate` before `next build`
 *
 * Idempotent — already-applied migrations are skipped. Safe to run on every
 * deploy. First run on the existing prod DB requires a one-time baseline
 * marker (see docs/MIGRATIONS.md).
 *
 * The runner uses postgres.js (max: 1 connection) instead of the shared
 * db/client.ts pool so it doesn't interfere with any other concurrent
 * connection on the same deploy.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  // Convenience: load env file if DATABASE_URL isn't already set. Same
  // override semantics as drizzle.config.ts — `DRIZZLE_ENV_FILE` wins.
  const envFile = process.env.DRIZZLE_ENV_FILE ?? ".env.local";
  if (!process.env.DATABASE_URL) {
    try {
      const proc = process as unknown as { loadEnvFile?: (p: string) => void };
      if (typeof proc.loadEnvFile === "function") proc.loadEnvFile(envFile);
    } catch {
      // file may not exist; we'll error below if DATABASE_URL is still unset
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Two contexts:
    //
    //   1. Local dev or manual run — the user wants to apply migrations and
    //      forgot to set DATABASE_URL. We should fail loudly so they fix it.
    //
    //   2. Vercel build step — DATABASE_URL might be marked "Sensitive" and
    //      therefore unavailable at build time, even though it's set for
    //      runtime. In that case we MUST NOT fail the build; we just skip
    //      and warn. Migrations can be run separately from a workstation
    //      (DATABASE_URL=<prod-url> pnpm db:migrate) or via a one-off Vercel
    //      function.
    //
    // We detect "we're in a Vercel build" by checking the VERCEL env var,
    // which is set on every Vercel build (and runtime).
    const inVercelBuild = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
    if (inVercelBuild) {
      console.warn(
        "[migrate] DATABASE_URL is not set at build time. Skipping migrations " +
          "for this build. Run them manually with `DATABASE_URL=<prod-url> pnpm db:migrate` " +
          "or set DATABASE_URL as a non-Sensitive Vercel env var so it's exposed at build.",
      );
      return; // exit 0 — let the build continue
    }
    console.error(
      "[migrate] DATABASE_URL is not set. Set it inline, put it in .env.local, " +
        "or use DRIZZLE_ENV_FILE=.env.production pnpm db:migrate.",
    );
    process.exit(2);
  }

  // The migrations folder lives at drizzle/ relative to the project root.
  // drizzle-kit generate writes versioned .sql files there.
  const migrationsFolder = resolve(process.cwd(), "drizzle");

  // drizzle-orm/migrator needs drizzle/meta/_journal.json to exist. Until
  // the first `pnpm db:generate` has been run, the folder is empty and
  // migrate() would throw "Can't find meta/_journal.json". Treat that as
  // "no migrations yet" — success — so the build pipeline doesn't fail
  // before any migration is even written.
  const journalPath = resolve(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    console.log(
      `[migrate] No migrations to apply (${journalPath} not found). ` +
        `Run \`pnpm db:generate\` to create the first migration.`,
    );
    return;
  }

  console.log(`[migrate] Applying migrations from ${migrationsFolder}`);
  console.log(`[migrate] Target: ${redact(databaseUrl)}`);

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const db = drizzle(client);

  const startedAt = Date.now();
  try {
    await migrate(db, { migrationsFolder });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[migrate] ✓ Done in ${elapsed}s`);
  } catch (err) {
    console.error("[migrate] ✗ Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

function redact(url: string): string {
  return url.replace(/:[^@/]+@/, ":***@");
}

main();
