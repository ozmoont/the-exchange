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
import { createHash, createHmac } from "node:crypto";

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
 *
 * The `eventKey` parameter is a stable identifier for the LOGICAL event
 * being delivered. Re-calling sendOutboundEvent with the same eventKey
 * produces the same event_id every time, so partners can dedupe on event_id
 * even when our delivery retries. Format suggestion:
 *   `${transitId}:${eventType}:${count or version}`
 * e.g. `abc-123:transit.rerouted:2` for the second reroute attempt of one
 * transit.
 *
 * If eventKey is omitted, a fresh deterministic id is generated from
 * (originator, eventType, payload) — this is a best-effort fallback and
 * means retries with identical payloads dedupe, but retries with mutated
 * payloads (e.g. an updated timestamp inside) do not.
 */
export async function sendOutboundEvent(
  originatorPartnerId: string,
  eventType: string,
  payload: OutboundEventPayload,
  eventKey?: string,
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

  // Stable event id derivation. Using SHA-256 over the eventKey (or a
  // fingerprint of the payload as fallback) keeps the id deterministic
  // across retries — partners can dedupe on event_id reliably. Truncated
  // to 32 hex chars (128 bits) for sensible payload size.
  const idMaterial =
    eventKey ??
    `fallback:${originatorPartnerId}:${eventType}:${stableStringify(payload)}`;
  const eventId = createHash("sha256").update(idMaterial).digest("hex").slice(0, 32);

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
    // A unique-constraint violation here is meaningful with stable event ids:
    // it means we're retrying the same logical event. That's expected — the
    // first record stays, the retry is silently swallowed.
  }

  if (delivered) {
    return { ok: true, eventId, status };
  }
  return { ok: false, reason: "delivery_failed", status, message: errorMessage };
}

/**
 * Stable JSON stringify — sorted keys, no whitespace. Two equivalent objects
 * with different key orders produce the same string. Used to fingerprint
 * payloads when no explicit eventKey is provided.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
