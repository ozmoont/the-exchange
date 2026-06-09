import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { transits, transitEvents, auditLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { authenticateInboundCaller } from "@/lib/icabbi-inbound-auth";
import { normaliseICabbiInboundBooking, type ICabbiInboundBooking } from "@/lib/icabbi-payload";
import {
  checkRateLimit,
  LIMIT_INGEST_PER_PARTNER,
  WINDOW_INGEST_SECONDS,
} from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { captureError } from "@/lib/observability";

/**
 * PATCH /api/icabbi/bookings/:bookingId — edit-before-allocation.
 *
 * Per iCabbi BDD Section 1.3 dual API surface. The originator (iCabbi
 * acting as fleet-side caller) can edit a booking they previously
 * offered to us — change pickup, dropoff, scheduled time, vehicle type,
 * notes — **but only before it's been pushed to a recipient.**
 *
 * Once the transit reaches 'pushed' / 'accepted' / further, the booking
 * is in flight with a recipient and editing requires a cancellation +
 * re-offer (POST /cancellations followed by POST /bookings).
 *
 * Editable fields (canonical):
 *   pickup.lat/lng/address
 *   dropoff.lat/lng/address
 *   booking.type + booking.scheduled_at (must remain consistent)
 *   vehicle_type
 *   passenger.name/phone/count
 *   notes / instructions
 *   fare_estimate
 *
 * NOT editable:
 *   booking_id (use it as the URL parameter)
 *   originator (Bearer token authoritative)
 *
 * Response:
 *   200 { status: 'updated', exchange_transit_id, updated_fields }
 *   401 unauthorised
 *   404 booking_id not found for this originator
 *   409 booking already pushed — cancellation + re-offer required
 *   400 malformed body
 */

const EDITABLE_BEFORE_PUSH = new Set([
  "received",
  "routing",
  "no_match",
  "paused",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const auth = await authenticateInboundCaller(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const originatorPartner = auth.partner;
  const { bookingId } = await params;
  if (!bookingId) {
    return NextResponse.json({ error: "missing_booking_id" }, { status: 400 });
  }

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

  let raw: ICabbiInboundBooking;
  try {
    raw = (await req.json()) as ICabbiInboundBooking;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "invalid_envelope_shape" }, { status: 400 });
  }

  // Find the transit. Note: PATCH uses the URL param bookingId, not the
  // body's booking_id — the URL is authoritative. If the body also carries
  // a booking_id, ignore it.
  const [transit] = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.originatorPartnerId, originatorPartner.id),
        eq(transits.originatorBookingExternalId, bookingId),
      ),
    );

  if (!transit) {
    return NextResponse.json({ error: "not_found", booking_id: bookingId }, { status: 404 });
  }

  // Reject if past the editable window.
  if (!EDITABLE_BEFORE_PUSH.has(transit.status)) {
    return NextResponse.json(
      {
        error: "already_allocated",
        current_status: transit.status,
        message:
          "Booking has been pushed to a recipient. Cancel via POST /cancellations and re-offer if changes are needed.",
        exchange_transit_id: transit.id,
      },
      { status: 409 },
    );
  }

  // Build an effective payload by merging current booking_payload with the
  // PATCH input, so partial PATCH (only changing dropoff, for example)
  // doesn't wipe out other fields. We re-normalise the merged object
  // through the standard validator so the same shape rules apply.
  const current = (transit.bookingPayload ?? {}) as Record<string, unknown>;
  const currentRaw = (current.raw as Record<string, unknown> | undefined)?.original as
    | Record<string, unknown>
    | undefined;
  // Preserve booking_id from the URL — overwrites any body booking_id.
  const merged: ICabbiInboundBooking = {
    ...(currentRaw ?? {}),
    ...raw,
    booking_id: bookingId,
  };

  const normalised = normaliseICabbiInboundBooking(merged);
  if (!normalised.ok) {
    return NextResponse.json(
      { error: normalised.error, missingFields: normalised.missingFields },
      { status: 400 },
    );
  }

  // Identify which canonical fields actually changed — useful for the
  // audit log + the response. Compare a few obvious top-level paths.
  const updatedFields: string[] = [];
  const before = current as {
    pickup?: { lat?: number; lng?: number; address?: string };
    dropoff?: { lat?: number; lng?: number; address?: string };
    vehicleType?: string;
    bookingType?: string;
    scheduledFor?: string;
    passenger?: { name?: string; phone?: string };
    notes?: string;
    instructions?: string;
    fareEstimatePence?: number;
  };
  const after = normalised.booking;
  if (before.pickup?.lat !== after.pickup.lat || before.pickup?.lng !== after.pickup.lng || before.pickup?.address !== after.pickup.address) {
    updatedFields.push("pickup");
  }
  if (before.dropoff?.lat !== after.dropoff.lat || before.dropoff?.lng !== after.dropoff.lng || before.dropoff?.address !== after.dropoff.address) {
    updatedFields.push("dropoff");
  }
  if (before.vehicleType !== after.vehicleType) updatedFields.push("vehicle_type");
  if (before.bookingType !== after.bookingType) updatedFields.push("booking_type");
  if (before.scheduledFor !== after.scheduledFor) updatedFields.push("scheduled_at");
  if (before.passenger?.name !== after.passenger.name || before.passenger?.phone !== after.passenger.phone) {
    updatedFields.push("passenger");
  }
  if (before.notes !== after.notes) updatedFields.push("notes");
  if (before.instructions !== after.instructions) updatedFields.push("instructions");
  if (before.fareEstimatePence !== after.fareEstimatePence) updatedFields.push("fare_estimate");

  if (updatedFields.length === 0) {
    // Idempotent no-op: client PATCHed the same values they had. Return
    // 200 with empty updated_fields so they know nothing happened.
    return NextResponse.json(
      {
        status: "no_changes",
        exchange_transit_id: transit.id,
        current_status: transit.status,
      },
      { status: 200 },
    );
  }

  try {
    await db
      .update(transits)
      .set({
        bookingPayload: after as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(transits.id, transit.id));

    await db.insert(transitEvents).values({
      transitId: transit.id,
      status: transit.status,
      detail: {
        kind: "booking_edited_by_originator",
        updated_fields: updatedFields,
      },
      actor: "partner_webhook",
      actorRef: originatorPartner.id,
    });

    await db.insert(auditLog).values({
      category: "booking",
      actor: "partner_webhook",
      actorRef: originatorPartner.id,
      action: "transit.edited_by_originator",
      subjectType: "transit",
      subjectId: transit.id,
      before: current,
      after: after as unknown as Record<string, unknown>,
    });

    log.info("inbound iCabbi booking edited", {
      area: "icabbi-inbound-patch",
      transit_id: transit.id,
      originator_partner_id: originatorPartner.id,
      updated_fields: updatedFields,
    });

    return NextResponse.json(
      {
        status: "updated",
        exchange_transit_id: transit.id,
        current_status: transit.status,
        updated_fields: updatedFields,
      },
      { status: 200 },
    );
  } catch (err) {
    captureError(err, {
      area: "icabbi-inbound-patch",
      originator_partner_id: originatorPartner.id,
      transit_id: transit.id,
    });
    return NextResponse.json(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
