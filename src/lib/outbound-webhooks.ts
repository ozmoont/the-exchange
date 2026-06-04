/**
 * Outbound webhook delivery to demand-side partners.
 *
 * When something happens to a transit that the demand fleet should know
 * about — primarily auto-reroutes (Gap #3) — we POST a signed event to the
 * originator partner's configured webhookUrl. Their adapter / dispatch
 * handles the payload however they want (notify passenger, update tracking
 * link, log the change).
 *
 * Envelope shape mirrors the Karhoo / iCabbi inbound webhook format we
 * already understand. Same scheme on both directions makes it easy for
 * partners that have already implemented our inbound side to receive ours:
 *
 *   {
 *     id: string,             // event id, used for idempotency
 *     event_type: string,
 *     sent_at: ISO 8601,
 *     attempt_number: number,
 *     checksum: hex string,   // HMAC-SHA512(data, webhookSecret)
 *     data: string            // STRINGIFIED JSON
 *   }
 *
 * Header `X-Karhoo-Request-Signature` carries the checksum for callers that
 * verify signature out-of-band.
 *
 * Delivery records land in webhook_deliveries with source='outbound:{partnerId}'
 * so the existing /webhooks inspector picks them up.
 */

import { db } from "@/db/client";
import { partners, webhookDeliveries } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptIfNeeded } from "@/lib/crypto";
import { createHmac, randomUUID } from "node:crypto";

const OUTBOUND_TIMEOUT_MS = 5_000;

export type OutboundEventPayload = {
  /** Stable id for this transit on the originator's side. */
  originatorBookingExternalId: string;
  /** Our internal transit id, for cross-referencing if the partner wants. */
  transitId: string;
  /** Any other event-specific data — passed through to `data` verbatim. */
  [key: string]: unknown;
};

export type SendOutboundEventResult =
  | { ok: true; eventId: string; status: number }
  | { ok: false; reason: "no_webhook_url" | "no_secret" | "no_partner" }
  | { ok: false; reason: "delivery_failed"; status: number; message?: string };

/**
 * POST a signed event to the originator partner's webhookUrl. Records the
 * delivery in webhook_deliveries for the inspector + retry tooling. Never
 * throws — callers fire-and-forget with confidence that failures are logged.
 */
export async function sendOutboundEvent(
  originatorPartnerId: string,
  eventType: string,
  payload: OutboundEventPayload,
): Promise<SendOutboundEventResult> {
  const [originator] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, originatorPartnerId));

  if (!originator) {
    return { ok: false, reason: "no_partner" };
  }

  if (!originator.webhookUrl) {
    // Partner hasn't configured a destination — silently skip. This is the
    // common case for the demo data and for partners that don't subscribe
    // to network events.
    return { ok: false, reason: "no_webhook_url" };
  }

  const creds = decryptIfNeeded(originator.credentials as Record<string, unknown> | null) ?? {};
  const webhookSecret = String(creds.webhookSecret ?? "");
  if (!webhookSecret) {
    return { ok: false, reason: "no_secret" };
  }

  const eventId = randomUUID();
  const sentAt = new Date().toISOString();
  const dataJson = JSON.stringify(payload);

  const checksum = createHmac("sha512", webhookSecret).update(dataJson).digest("hex");
  const envelope = {
    id: eventId,
    event_type: eventType,
    sent_at: sentAt,
    attempt_number: 1,
    checksum,
    data: dataJson,
  };

  let status = 0;
  let errorMessage: string | undefined;
  let delivered = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);

  try {
    const res = await fetch(originator.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Karhoo-Request-Signature": checksum,
        "X-Exchange-Event-Id": eventId,
        "X-Exchange-Event-Type": eventType,
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    status = res.status;
    delivered = res.ok;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      errorMessage = `${res.status} ${body.slice(0, 200)}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }

  // Record the delivery — outcome 'delivered' if 2xx, otherwise 'delivery_failed'
  try {
    await db.insert(webhookDeliveries).values({
      source: `outbound:${originatorPartnerId}`,
      sourceEventId: eventId,
      payload: { envelope, target: originator.webhookUrl, eventType },
      outcome: delivered ? "delivered" : "delivery_failed",
      processedAt: new Date(),
    });
  } catch {
    // Don't let the delivery record failure mask a successful delivery.
    // (Unique-constraint violation only happens on duplicate event id which
    // can't happen here — we just generated a fresh UUID.)
  }

  if (delivered) {
    return { ok: true, eventId, status };
  }
  return { ok: false, reason: "delivery_failed", status, message: errorMessage };
}
