import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { partners, partnerRules, syntheticTestRuns } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { routeBooking } from "@/lib/routing";
import { captureError } from "@/lib/observability";
import { log } from "@/lib/logger";

/**
 * Synthetic monitoring cron (P1-O4).
 *
 * Every hour, fire one test booking through the routing engine using
 * mock_icabbi partners. Record the outcome in synthetic_test_runs. Surface
 * the most recent run on /distribution so a glance at the dashboard tells
 * you whether the happy path is alive.
 *
 * Synthetic transits are tagged with bookingPayload.raw.synthetic=true and
 * the originator's external_id starts with 'SYNTH-' so they're easy to
 * filter out of operational views.
 *
 * Partner selection:
 *   1. SYNTHETIC_ORIGINATOR_ID + SYNTHETIC_RECIPIENT_ID env vars (preferred)
 *   2. Fallback: any two active mock_icabbi partners with mutual allow
 *
 * Auth: same as the queue drain — x-vercel-cron OR Authorization: Bearer.
 *
 * Failure modes:
 *   - No eligible pair → recorded as 'skipped_no_pair', not an error
 *   - routeBooking throws → captureError + recorded as 'error'
 *   - routeBooking returns 'pushed' → success
 *   - Any other outcome → captureError + recorded with that outcome
 */

export const dynamic = "force-dynamic";
const RUN_TIMEOUT_MS = 30_000;

// Static pickup/dropoff that won't ambiguously hit any specific city's
// service radius. Central UK-ish coordinates around Birmingham.
const SYNTH_PICKUP = { lat: 52.486, lng: -1.89, address: "[SYNTHETIC] Birmingham city" };
const SYNTH_DROPOFF = { lat: 52.486, lng: -1.85, address: "[SYNTHETIC] Birmingham east" };

export async function GET(req: NextRequest) {
  const cronHeader = req.headers.get("x-vercel-cron");
  const auth = req.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;
  const isVercelCron = cronHeader === "1";
  const hasValidBearer = expectedSecret && auth === `Bearer ${expectedSecret}`;
  if (!isVercelCron && !hasValidBearer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    // Pick the synthetic pair
    const pair = await pickSyntheticPair();
    if (!pair) {
      await db.insert(syntheticTestRuns).values({
        outcome: "skipped_no_pair",
        elapsedMs: Date.now() - startedAt,
        errorMessage: "no mock_icabbi partners with mutual allow",
      });
      log.warn("synthetic-test skipped — no eligible pair");
      return NextResponse.json({ status: "skipped", reason: "no_pair" });
    }

    // Build the synthetic booking
    const externalId = `SYNTH-${Date.now()}`;
    const booking = {
      originatorBookingExternalId: externalId,
      bookingType: "asap" as const,
      channel: "api" as const,
      pickup: SYNTH_PICKUP,
      dropoff: SYNTH_DROPOFF,
      vehicleType: "standard",
      passengerCount: 1,
      fareEstimatePence: 1500,
      passenger: { name: "[Synthetic Monitor]", phone: "+44 0 0000 0000" },
      raw: { synthetic: true, source: "synthetic_monitor" },
    };

    // Race with a hard timeout so a stuck routing call doesn't hold the
    // cron forever (Vercel function timeout is 10s on Hobby / 60s on Pro).
    const result = await Promise.race([
      routeBooking({
        originatorPartnerId: pair.originatorId,
        booking,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`synthetic_timeout_${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS),
      ),
    ]);

    const elapsedMs = Date.now() - startedAt;

    await db.insert(syntheticTestRuns).values({
      outcome: result.outcome,
      transitId: result.transitId,
      originatorPartnerId: pair.originatorId,
      elapsedMs,
    });

    if (result.outcome !== "pushed") {
      // Anything other than 'pushed' is a degradation — capture for alert
      captureError(new Error(`synthetic_outcome_${result.outcome}`), {
        area: "synthetic_monitor",
        transit_id: result.transitId,
        outcome: result.outcome,
      });
    }

    return NextResponse.json({
      status: "ok",
      outcome: result.outcome,
      transitId: result.transitId,
      elapsedMs,
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const errMsg = err instanceof Error ? err.message : String(err);
    const outcome = errMsg.startsWith("synthetic_timeout_") ? "timeout" : "error";

    await db.insert(syntheticTestRuns).values({
      outcome,
      elapsedMs,
      errorMessage: errMsg.slice(0, 500),
    });

    captureError(err, { area: "synthetic_monitor", outcome });

    return NextResponse.json(
      { status: "error", outcome, elapsedMs, error: errMsg.slice(0, 200) },
      { status: 200 }, // 200 so Vercel doesn't mark the cron run failed (we've already captured the error)
    );
  }
}
export const POST = GET;

async function pickSyntheticPair(): Promise<{ originatorId: string; recipientId: string } | null> {
  const envOrig = process.env.SYNTHETIC_ORIGINATOR_ID;
  const envRecv = process.env.SYNTHETIC_RECIPIENT_ID;
  if (envOrig && envRecv && envOrig !== envRecv) {
    return { originatorId: envOrig, recipientId: envRecv };
  }

  // Fallback: pick any pair of mock_icabbi partners with mutual allow
  // between them. Single SQL with a self-join keeps it cheap.
  const result = await db.execute<{ originatorId: string; recipientId: string }>(sql.raw(`
    SELECT o.id AS "originatorId", r.id AS "recipientId"
    FROM partners o
    INNER JOIN partner_rules pr_out
      ON pr_out.originator_id = o.id AND pr_out.rule = 'allow'
    INNER JOIN partners r ON r.id = pr_out.recipient_id
    INNER JOIN partner_rules pr_in
      ON pr_in.originator_id = r.id
      AND pr_in.recipient_id = o.id
      AND pr_in.rule = 'allow'
    WHERE o.status = 'active' AND o.adapter_key = 'mock_icabbi'
      AND r.status = 'active' AND r.adapter_key = 'mock_icabbi'
      AND o.id <> r.id
    LIMIT 1
  `));

  const rows = Array.isArray(result)
    ? (result as unknown as { originatorId: string; recipientId: string }[])
    : (result as unknown as { rows: { originatorId: string; recipientId: string }[] }).rows ?? [];

  return rows[0] ?? null;
}

void and;
void eq;
void partners;
void partnerRules;
