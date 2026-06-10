import { db } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Returns true if this is the first time we've seen (source, sourceEventId).
 * Returns false if it's a duplicate — caller should ack and skip.
 *
 * Writes a row with outcome=null; call `recordWebhookOutcome` once processing
 * is done to update the row with what actually happened. Useful for the
 * `/webhooks` inspector to surface success/failure.
 */
export async function isFreshDelivery(
  source: string,
  sourceEventId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    await db.insert(webhookDeliveries).values({ source, sourceEventId, payload });
    return true;
  } catch {
    // unique constraint violation = duplicate
    return false;
  }
}

export type WebhookOutcome =
  | "applied"
  | "routed"
  | "orphan"
  | "duplicate"
  | "ack_unhandled"
  | "signature_invalid"
  // auth_invalid covers both HMAC-failed AND token-mismatch cases. We
  // keep signature_invalid for backwards-compat (older deliveries used
  // it before the token-in-URL path was added).
  | "auth_invalid"
  | "error";

/**
 * Update the previously-recorded delivery row with the processing outcome.
 */
export async function recordWebhookOutcome(
  source: string,
  sourceEventId: string,
  outcome: WebhookOutcome,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ outcome, processedAt: new Date() })
    .where(
      and(eq(webhookDeliveries.source, source), eq(webhookDeliveries.sourceEventId, sourceEventId)),
    );
}

/**
 * Record a delivery that we rejected BEFORE the idempotency insert (HMAC
 * signature mismatch, missing partner, malformed JSON). Uses a synthetic id
 * so it doesn't collide with a real envelope id ever delivered.
 */
export async function recordRejectedDelivery(
  source: string,
  reason: WebhookOutcome,
  payload: Record<string, unknown>,
): Promise<void> {
  const syntheticId = `rejected-${reason}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await db.insert(webhookDeliveries).values({
      source,
      sourceEventId: syntheticId,
      payload,
      outcome: reason,
      processedAt: new Date(),
    });
  } catch {
    // unique-constraint race — vanishingly unlikely; ignore
  }
}
