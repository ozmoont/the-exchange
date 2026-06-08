import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { transits } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { authenticateInboundCaller } from "@/lib/icabbi-inbound-auth";
import { normaliseICabbiInboundBooking, type ICabbiInboundBooking } from "@/lib/icabbi-payload";
import { receiveBooking } from "@/lib/routing";
import {
  checkRateLimit,
  LIMIT_INGEST_PER_PARTNER,
  WINDOW_INGEST_SECONDS,
} from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { captureError } from "@/lib/observability";

/**
 * Inbound booking offer from an iCabbi tenant acting as a fleet caller.
 *
 * Per BDD Epic 2 / STRATEGY.md decision #12, iCabbi has The Exchange
 * registered as a virtual fleet inside their Networking Engine. When
 * their internal dispatch can't find a driver, they offer the booking
 * to us via this endpoint. We act as the broker, finding an external
 * partner (FreeNow, future real partners) to fulfil it.
 *
 * Auth: Bearer token in Authorization header, generated when the iCabbi
 * tenant was Connected via /partners/[id]/integration. Identifies the
 * originator partner.
 *
 * Response:
 *   200 { status: 'accepted', exchange_transit_id, recipient_partner? }
 *       — booking received + routing kicked off (async)
 *   400 { error, missingFields? }
 *   401 { error }
 *   409 { error: 'duplicate', exchange_transit_id }
 *   422 { error: 'no_coverage' }
 *   429 { error: 'rate_limited' }
 */
export async function POST(req: NextRequest) {
  // 1. Auth — identify the calling iCabbi tenant
  const auth = await authenticateInboundCaller(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const originatorPartner = auth.partner;

  // 2. Rate limit per originator. Same budget as the inbound webhook
  //    handler — 60/min default, tunable via env.
  const rl = await checkRateLimit(
    `inbound_icabbi:${originatorPartner.id}`,
    Number(process.env.WEBHOOK_INGEST_RATE_LIMIT ?? LIMIT_INGEST_PER_PARTNER),
    WINDOW_INGEST_SECONDS,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rl.retryAfterSeconds },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) },
      },
    );
  }

  // 3. Parse body
  let raw: ICabbiInboundBooking;
  try {
    raw = (await req.json()) as ICabbiInboundBooking;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "invalid_envelope_shape" }, { status: 400 });
  }

  // 4. Translate iCabbi shape → NormalisedBooking
  const normalised = normaliseICabbiInboundBooking(raw);
  if (!normalised.ok) {
    return NextResponse.json(
      { error: normalised.error, missingFields: normalised.missingFields },
      { status: 400 },
    );
  }

  // 5. Idempotency — same booking_id from same originator returns the
  //    existing transit, no second routing kicked off.
  const existing = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.originatorPartnerId, originatorPartner.id),
        eq(transits.originatorBookingExternalId, normalised.iCabbiBookingId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    log.info("inbound iCabbi booking — duplicate, returning existing transit", {
      area: "icabbi-inbound",
      originator_partner_id: originatorPartner.id,
      icabbi_booking_id: normalised.iCabbiBookingId,
      transit_id: existing[0].id,
    });
    return NextResponse.json(
      {
        status: "duplicate",
        exchange_transit_id: existing[0].id,
        current_status: existing[0].status,
      },
      { status: 409 },
    );
  }

  // 6. Hand off to the routing engine. receiveBooking() creates a transit
  //    row at status=received and returns; the actual routing decision
  //    happens on the next async drain (cron / demo tick). This keeps the
  //    response inside the BDD-spec 2s budget.
  try {
    const result = await receiveBooking({
      originatorPartnerId: originatorPartner.id,
      booking: normalised.booking,
    });

    log.info("inbound iCabbi booking accepted", {
      area: "icabbi-inbound",
      originator_partner_id: originatorPartner.id,
      originator_partner_name: originatorPartner.name,
      icabbi_booking_id: normalised.iCabbiBookingId,
      transit_id: result.transitId,
      outcome: result.outcome,
    });

    return NextResponse.json(
      {
        status: "accepted",
        exchange_transit_id: result.transitId,
        // recipient_partner is unknown at receive time — async drain
        // picks the candidate. iCabbi can poll /transits/<id> or wait
        // for our status-back webhook (when we implement it on their
        // /fleet/status endpoint).
      },
      { status: 200 },
    );
  } catch (err) {
    captureError(err, {
      area: "icabbi-inbound",
      originator_partner_id: originatorPartner.id,
      icabbi_booking_id: normalised.iCabbiBookingId,
    });
    return NextResponse.json(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
