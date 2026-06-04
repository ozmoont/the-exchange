/**
 * One-time helper for marking a migration as "already applied" without
 * actually running its SQL. Used exactly once when migrating an existing
 * prod DB from the `db:push` workflow to versioned migrations — the
 * generated baseline migration represents the current schema, but trying
 * to run it would fail on every CREATE TABLE because the tables exist.
 *
 * Run with:
 *   DATABASE_URL='<prod>' pnpm exec tsx scripts/mark-migration-applied.ts drizzle/0000_baseline.sql
 *
 * The script:
 *   1. Reads the migration .sql file and its corresponding snapshot
 *   2. Computes the hash drizzle-orm/migrator expects
 *   3. INSERTs a row into __drizzle_migrations claiming it's applied
 *
 * After running, `pnpm db:migrate` will skip the baseline and proceed
 * to any subsequent migrations normally.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: mark-migration-applied.ts <path-to-migration.sql>");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  const absPath = resolve(process.cwd(), path);
  if (!existsSync(absPath)) {
    console.error(`Migration file not found: ${absPath}`);
    process.exit(2);
  }

  const sql = readFileSync(absPath, "utf8");
  // drizzle-orm/migrator hashes the migration body to verify it hasn't been
  // tampered with since application. Compute the same SHA-256 hex hash.
  const hash = createHash("sha256").update(sql).digest("hex");

  // The migration name in __drizzle_migrations is the file's basename minus
  // the .sql extension.
  const tag = basename(absPath, ".sql");

  const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    // Create the tracking table if it doesn't exist (drizzle-orm/migrator does
    // this on first migrate; we replicate it here so this script also works
    // on a totally fresh DB).
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);
    // Some drizzle versions store in the public schema instead. Try both.
    await client.unsafe(`
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);

    // Insert the marker. Use Date.now() as the created_at marker.
    const now = Date.now();
    await client`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${hash}, ${now})
    `;

    console.log(`✓ Marked ${tag} as applied (hash=${hash.slice(0, 12)}…)`);
    console.log("Next `pnpm db:migrate` will skip the baseline and proceed to subsequent migrations.");
  } catch (err) {
    console.error("Failed to mark migration applied:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.end();
  }

  void dirname;
}

main();
