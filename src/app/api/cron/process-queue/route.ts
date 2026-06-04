import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { processReceivedTransits } from "@/lib/routing";

/**
 * Vercel cron endpoint that drains the routing queue.
 *
 * Vercel cron schedule lives in vercel.json. This route runs once per
 * minute, picks up to 20 received transits, and routes them via the
 * existing routing engine.
 *
 * Auth:
 *   - When invoked via Vercel cron, the platform sets `x-vercel-cron: 1`.
 *     We allow that header.
 *   - For manual invocation (testing), require Authorization: Bearer
 *     $CRON_SECRET if CRON_SECRET env var is set.
 *
 * Returns the outcome counts as JSON. Vercel cron logs these in the
 * dashboard so a glance at /logs shows queue health.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronHeader = req.headers.get("x-vercel-cron");
  const auth = req.headers.get("authorization");

  const expectedSecret = process.env.CRON_SECRET;
  const isVercelCron = cronHeader === "1";
  const hasValidBearer =
    expectedSecret && auth === `Bearer ${expectedSecret}`;

  if (!isVercelCron && !hasValidBearer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const outcomes = await processReceivedTransits(50);
  const elapsedMs = Date.now() - startedAt;

  return NextResponse.json({
    status: "ok",
    elapsedMs,
    ...outcomes,
  });
}

// POST also supported in case external schedulers expect it
export const POST = GET;
