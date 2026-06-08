import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { transits, transitEvents, auditLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { authenticateInboundCaller } from "@/lib/icabbi-inbound-auth";
import { getAdapterForPartner } from "@/adapters/registry";
import {
  checkRateLimit,
  LIMIT_INGEST_PER_PARTNER,
  WINDOW_INGEST_SECONDS,
} from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { captureError } from "@/lib/observability";

/**
 * Cancellation of a booking previously offered to The Exchange by an
 * iCabbi tenant. Cascades to the recipient adapter's cancelBooking()
 * (best-effort) and marks the transit cancelled.
 *
 * Body:
 *   { booking_id: '<iCabbi-side id>', reason?: string, reason_detail?: string }
 *
 * Response:
 *   200 { status: 'cancelled', transit_id }
 *   404 { error: 'not_found' }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateInboundCaller(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const originatorPartner = auth.partner;

  const rl = await checkRateLimit(
    `inbound_icabbi:${originatorPartner.id}`,
    Number(process.env.WEBHOOK_INGEST_RATE_LIMIT ?? LIMIT_INGEST_PER_PARTNER),
    WINDOW_INGEST_SECONDS,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } },
    );
  }

  let body: { booking_id?: string; bookingId?: string; reason?: string; reason_detail?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const iCabbiBookingId = String(body?.booking_id ?? body?.bookingId ?? "").trim();
  if (!iCabbiBookingId) {
    return NextResponse.json({ error: "missing_booking_id" }, { status: 400 });
  }

  const reason = String(body?.reason ?? "originator_cancelled");
  const reasonDetail = typeof body?.reason_detail === "string" ? body.reason_detail : null;

  // Find the transit. Originator partner is identified by the Bearer token;
  // the iCabbi-side id is what they originally sent us.
  const [transit] = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.originatorPartnerId, originatorPartner.id),
        eq(transits.originatorBookingExternalId, iCabbiBookingId),
      ),
    );

  if (!transit) {
    log.warn("inbound iCabbi cancellation for unknown booking", {
      area: "icabbi-inbound-cancel",
      originator_partner_id: originatorPartner.id,
      icabbi_booking_id: iCabbiBookingId,
    });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Already cancelled? Idempotent — return success without touching anything.
  if (transit.status === "cancelled" || transit.status === "completed") {
    return NextResponse.json(
      { status: "already_terminal", transit_id: transit.id, current_status: transit.status },
      { status: 200 },
    );
  }

  // Best-effort cascade to the recipient. If we never pushed to anyone yet
  // (status = received/routing/no_match/paused), there's no recipient to
  // tell — just mark cancelled.
  if (transit.recipientPartnerId && transit.recipientBookingExternalId) {
    try {
      const adapter = await getAdapterForPartner(transit.recipientPartnerId);
      await adapter.cancelBooking({
        externalId: transit.recipientBookingExternalId,
        reason: `originator_cancelled:${reason}`,
      });
    } catch (err) {
      log.warn("recipient cancelBooking failed during inbound iCabbi cancellation", {
        area: "icabbi-inbound-cancel",
        transit_id: transit.id,
        err: err instanceof Error ? err.message : String(err),
      });
      // Don't fail the request — we still mark our side cancelled. The
      // recipient may already have cancelled on their own, or be down.
    }
  }

  // Mark cancelled, log event, audit.
  await db
    .update(transits)
    .set({ status: "cancelled", acceptDeadline: null, updatedAt: new Date() })
    .where(eq(transits.id, transit.id));

  await db.insert(transitEvents).values({
    transitId: transit.id,
    status: "cancelled",
    detail: {
      kind: "originator_cancelled",
      reason,
      reason_detail: reasonDetail,
    },
    actor: "partner_webhook",
    actorRef: originatorPartner.id,
  });

  await db.insert(auditLog).values({
    category: "booking",
    actor: "partner_webhook",
    actorRef: originatorPartner.id,
    action: "transit.cancelled_by_originator",
    subjectType: "transit",
    subjectId: transit.id,
    before: { status: transit.status },
    after: { status: "cancelled", reason, reason_detail: reasonDetail },
  });

  log.info("inbound iCabbi cancellation applied", {
    area: "icabbi-inbound-cancel",
    transit_id: transit.id,
    originator_partner_id: originatorPartner.id,
  });

  try {
    void captureError;
    // no error to capture on success path
  } catch {
    // unreachable
  }

  return NextResponse.json(
    { status: "cancelled", transit_id: transit.id },
    { status: 200 },
  );
}
