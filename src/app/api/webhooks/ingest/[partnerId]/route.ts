import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/db/client";
import { partners, transits } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAdapterForPartner } from "@/adapters/registry";
import { isFreshDelivery, recordWebhookOutcome, recordRejectedDelivery } from "@/lib/idempotency";
import { routeBooking, forwardStatusUpdate } from "@/lib/routing";

/**
 * Per-partner webhook receiver. Each connected partner gets a unique URL:
 *   POST /api/webhooks/ingest/<partnerId>
 *
 * Authentication: HMAC-SHA512 of the raw body, signed with the partner's
 * webhookSecret (stored in partners.credentials.webhookSecret). The signature
 * is sent in the X-Karhoo-Request-Signature header as lowercase hex.
 *
 * Per the iCabbi/Karhoo webhook contract:
 *   - 200-ack the request when verified and processed (or skipped as a duplicate).
 *   - Return 200 even if the event is one we don't handle (FinalFareReleased,
 *     DriverPositionChanged) — they'll retry on 4xx/5xx and we don't want that.
 *   - Only return 4xx for genuine bad input (missing partner, bad signature).
 *
 * The same code path handles two flows:
 *   - kind: "status" — translates to forwardStatusUpdate on the receiving transit
 *   - kind: "create" — would run the routing engine for inbound network bookings
 *     (the originator-fires-create case is still TBD; left in for forward compat)
 */

const SIGNATURE_HEADER = "x-karhoo-request-signature";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const { partnerId } = await params;
  if (!partnerId) {
    return NextResponse.json({ error: "missing_partner_id" }, { status: 400 });
  }

  // Load partner + webhook secret
  const [partner] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!partner) {
    return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
  }

  const creds = (partner.credentials ?? {}) as { webhookSecret?: string };
  if (!creds.webhookSecret) {
    return NextResponse.json({ error: "partner_not_connected" }, { status: 400 });
  }

  // Read raw body BEFORE parsing — signature is computed over the exact bytes,
  // including any linefeeds / whitespace. Re-parsing then re-serializing would
  // break verification.
  const rawBody = await req.text();
  const provided = req.headers.get(SIGNATURE_HEADER) ?? "";

  if (!verifyHmacSha512(rawBody, provided, creds.webhookSecret)) {
    console.warn(
      `[webhook] HMAC verification failed for partner ${partnerId} (sig provided: ${provided ? "yes" : "no"})`,
    );
    await recordRejectedDelivery(`ingest:${partnerId}`, "signature_invalid", { raw_length: rawBody.length });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Parse envelope. iCabbi/Karhoo envelope:
  //   { id, event_type, sent_at, checksum, attempt_number, data: stringified-json }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const envelopeId = String(envelope.id ?? "");
  if (!envelopeId) {
    // No id = can't dedupe. Karhoo always sets this; reject as malformed.
    return NextResponse.json({ error: "missing_envelope_id" }, { status: 400 });
  }

  // Idempotency: same envelope id from the same partner is a no-op (retries
  // commonly fire when our handler is slow, then again at 10s and 30s).
  const fresh = await isFreshDelivery(`ingest:${partnerId}`, envelopeId, envelope);
  if (!fresh) {
    return NextResponse.json({ status: "duplicate" }, { status: 200 });
  }

  // Dispatch via the partner's adapter
  const adapter = await getAdapterForPartner(partnerId);
  const normalised = await adapter.normaliseInboundWebhook(envelope);

  const source = `ingest:${partnerId}`;

  // No-handler events (FinalFareReleased, DriverPositionChanged, unknown) — ack
  // and move on. Karhoo will not retry on 200.
  if (!normalised) {
    await recordWebhookOutcome(source, envelopeId, "ack_unhandled");
    return NextResponse.json({ status: "acked_unhandled", event_type: envelope.event_type }, { status: 200 });
  }

  if (normalised.kind === "create") {
    try {
      const result = await routeBooking({
        originatorPartnerId: partnerId,
        booking: normalised.booking,
      });
      await recordWebhookOutcome(source, envelopeId, "routed");
      return NextResponse.json({ status: "routed", outcome: result.outcome, transitId: result.transitId }, { status: 200 });
    } catch (err) {
      await recordWebhookOutcome(source, envelopeId, "error");
      throw err;
    }
  }

  if (normalised.kind === "status") {
    const [transit] = await db
      .select()
      .from(transits)
      .where(eq(transits.recipientBookingExternalId, normalised.recipientBookingExternalId));

    if (!transit) {
      console.warn(
        `[webhook] status update for unknown trip ${normalised.recipientBookingExternalId} from partner ${partnerId}`,
      );
      await recordWebhookOutcome(source, envelopeId, "orphan");
      return NextResponse.json({ status: "orphan", trip_id: normalised.recipientBookingExternalId }, { status: 200 });
    }

    try {
      await forwardStatusUpdate({
        transitId: transit.id,
        newStatus: normalised.newStatus as never,
        detail: normalised.detail,
      });
      await recordWebhookOutcome(source, envelopeId, "applied");
      return NextResponse.json({ status: "applied", transit_id: transit.id, new_status: normalised.newStatus }, { status: 200 });
    } catch (err) {
      await recordWebhookOutcome(source, envelopeId, "error");
      throw err;
    }
  }

  await recordWebhookOutcome(source, envelopeId, "ack_unhandled");
  return NextResponse.json({ status: "acked_unhandled" }, { status: 200 });
}

/**
 * HMAC-SHA512 of body bytes, lowercase hex, constant-time compare.
 */
function verifyHmacSha512(body: string, providedHex: string, secret: string): boolean {
  if (!providedHex) return false;
  const expectedHex = createHmac("sha512", secret).update(body, "utf8").digest("hex");
  if (expectedHex.length !== providedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(providedHex.toLowerCase(), "utf8"));
  } catch {
    return false;
  }
}
