import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { retryDueDeliveries } from "@/lib/webhook-retry";
import { log } from "@/lib/logger";
import { captureError } from "@/lib/observability";

/**
 * Cron-driven outbound webhook retry. Runs every minute via vercel.json.
 *
 * Auth: Vercel cron calls authenticate via the `Authorization: Bearer
 * $CRON_SECRET` header. We accept either that or the `x-vercel-cron` flag
 * for backward compat with the project's other cron routes.
 *
 * Per iCabbi BDD Story 1.3 retry policy: 30s / 2min / 10min. After 3 failed
 * retries the delivery is flagged for admin review (visible on /webhooks).
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAuthenticatedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const outcome = await retryDueDeliveries();
    return NextResponse.json({ ok: true, ...outcome }, { status: 200 });
  } catch (err) {
    captureError(err, { area: "cron.retry-webhooks" });
    log.error("retry-webhooks cron crashed", {
      area: "cron.retry-webhooks",
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

function isAuthenticatedCron(req: NextRequest): boolean {
  // Vercel cron sends both an x-vercel-cron=1 header and a Bearer token
  // matching CRON_SECRET. Accept either to be tolerant of local manual hits
  // when CRON_SECRET is the same as a dev secret.
  if (req.headers.get("x-vercel-cron")) return true;
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // No secret configured — allow in dev mode for hand-testing, deny in prod.
    return process.env.NODE_ENV !== "production";
  }
  const provided = req.headers.get("authorization") ?? "";
  return provided === `Bearer ${expected}`;
}
