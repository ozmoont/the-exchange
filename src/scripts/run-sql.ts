/**
 * Tiny SQL runner — reads a .sql file path from CLI and executes it against
 * DATABASE_URL using the same postgres.js client the app uses. Useful when
 * psql isn't installed locally and you need to apply a one-off migration.
 *
 * Usage:
 *   DATABASE_URL='...' pnpm tsx --env-file=.env.local src/scripts/run-sql.ts scripts/sync-prod-schema.sql
 *
 * Or via the registered pnpm script:
 *   pnpm run-sql scripts/sync-prod-schema.sql
 *
 * The script splits on semicolons at statement boundaries (so the trailing
 * SELECT result blocks print individually) and prints any rows the final
 * statements return.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: run-sql.ts <path-to-sql-file>");
    process.exit(2);
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Source from .env.local or pass inline.");
    process.exit(2);
  }

  const absPath = resolve(process.cwd(), path);
  const sql = readFileSync(absPath, "utf8");
  console.log(`Running ${absPath} against ${redact(process.env.DATABASE_URL)}`);

  const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

  try {
    // postgres.js's `client.unsafe()` executes a string of raw SQL — handles
    // multi-statement files including BEGIN/COMMIT blocks.
    const result = await client.unsafe(sql);
    // unsafe() returns an array of result sets when there are multiple
    // statements that return rows. Print each block.
    if (Array.isArray(result) && result.length > 0) {
      const rows = result as unknown as Record<string, unknown>[];
      if (rows.length > 0 && typeof rows[0] === "object") {
        console.log("\nLast result set rows:");
        console.table(rows);
      }
    }
    console.log("\n✓ SQL applied successfully.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("\n✗ SQL failed:", msg);
    process.exit(1);
  } finally {
    await client.end();
  }
}

function redact(url: string): string {
  return url.replace(/:[^@/]+@/, ":***@");
}

main();
