import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

/**
 * GET /api/health
 *
 * Used by Vercel deploy checks, uptime monitors, and on-call to confirm
 * the app is alive and can talk to the database. Exempt from auth middleware
 * (it lives under /api/ but `/api/health` is whitelisted in middleware.ts).
 *
 * Returns 200 with version + db ping status when healthy. Returns 503 with
 * the failure mode when db is unreachable — monitors should treat that as
 * down even though the app process is technically responding.
 */

export const dynamic = "force-dynamic";

const STARTED_AT = new Date().toISOString();

export async function GET() {
  let dbStatus: "ok" | "error" = "ok";
  let dbError: string | null = null;
  let latencyMs = -1;

  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    latencyMs = Date.now() - t0;
  } catch (err) {
    dbStatus = "error";
    dbError = err instanceof Error ? err.message : String(err);
  }

  const body = {
    status: dbStatus === "ok" ? "ok" : "degraded",
    version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    deployedAt: process.env.VERCEL_GIT_COMMIT_AUTHOR_DATE ?? STARTED_AT,
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    db: { status: dbStatus, latencyMs, error: dbError },
    uptime: process.uptime(),
    now: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: dbStatus === "ok" ? 200 : 503 });
}
