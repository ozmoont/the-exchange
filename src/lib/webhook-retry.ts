/**
 * Outbound webhook retry loop.
 *
 * Per iCabbi BDD Story 1.3: failed status webhook deliveries are retried at
 * 30s / 2min / 10min after the initial failure. After 3 failed retries
 * (4 total attempts) the delivery is flagged for admin review and no
 * further retries are queued.
 *
 * The cron at /api/cron/retry-webhooks runs every minute and calls
 * retryDueDeliveries() which:
 *   1. Selects webhook_deliveries rows where next_attempt_at <= now
 *      AND outcome='delivery_failed' AND attempts < MAX_DELIVERY_ATTEMPTS
 *   2. For each row: re-POSTs the stored envelope to the original target
 *   3. Updates attempts + outcome + next_attempt_at based on the result
 *   4. After MAX_DELIVERY_ATTEMPTS unsuccessful attempts, sets flaggedAt
 *      and clears nextAttemptAt — surfaces on /webhooks inspector
 *
 * Idempotency: the envelope's event_id is stable across retries (computed
 * deterministically by sendOutboundEvent), so partners can dedupe on it.
 */

import { db } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import { and, eq, isNotNull, lte, lt, sql } from "drizzle-orm";
import { RETRY_INTERVALS_MS, MAX_DELIVERY_ATTEMPTS } from "@/lib/outbound-webhooks";
import { log } from "@/lib/logger";
import { captureError } from "@/lib/observability";

const RETRY_TIMEOUT_MS = 5_000;
// Cap how many retries we process per cron tick. Avoids one batch starving
// fresh deliveries if a partner is hard-down with hundreds queued.
const PER_TICK_LIMIT = 100;

export type RetryOutcome = {
  scanned: number;
  delivered: number;
  retried_failed: number; // failed again, more retries queued
  flagged: number; // hit MAX_DELIVERY_ATTEMPTS, flagged for admin
  errored: number; // crashed during retry attempt itself (network etc.)
};

/**
 * Walk every retry-due row and attempt redelivery. Safe to call repeatedly —
 * each row is updated atomically with its new state, so a concurrent tick
 * sees the latest attempt count.
 */
export async function retryDueDeliveries(): Promise<RetryOutcome> {
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.outcome, "delivery_failed"),
        isNotNull(webhookDeliveries.nextAttemptAt),
        lte(webhookDeliveries.nextAttemptAt, new Date()),
        lt(webhookDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
      ),
    )
    .limit(PER_TICK_LIMIT);

  const outcome: RetryOutcome = {
    scanned: due.length,
    delivered: 0,
    retried_failed: 0,
    flagged: 0,
    errored: 0,
  };

  for (const row of due) {
    try {
      const result = await retryOne(row);
      if (result === "delivered") outcome.delivered++;
      else if (result === "flagged") outcome.flagged++;
      else outcome.retried_failed++;
    } catch (err) {
      outcome.errored++;
      captureError(err, {
        area: "webhook-retry",
        delivery_id: row.id,
        attempts: row.attempts,
      });
    }
  }

  if (outcome.scanned > 0) {
    log.info("webhook retry tick complete", {
      area: "webhook-retry",
      ...outcome,
    });
  }
  return outcome;
}

type RetryResult = "delivered" | "retried_failed" | "flagged";

async function retryOne(
  row: typeof webhookDeliveries.$inferSelect,
): Promise<RetryResult> {
  // Pull the envelope + target from the stored payload. Shape per
  // sendOutboundEvent's insert: { envelope, target, eventType }.
  const stored = row.payload as {
    envelope?: {
      id?: string;
      event_type?: string;
      sent_at?: string;
      attempt_number?: number;
      checksum?: string;
      data?: string;
    };
    target?: string;
    eventType?: string;
  };

  const envelope = stored.envelope;
  const target = stored.target;

  if (!envelope || !target) {
    // Malformed delivery row — give up, don't keep retrying garbage.
    await db
      .update(webhookDeliveries)
      .set({
        outcome: "error",
        nextAttemptAt: null,
        flaggedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, row.id));
    log.warn("webhook retry row missing envelope/target — flagging", {
      area: "webhook-retry",
      delivery_id: row.id,
    });
    return "flagged";
  }

  const nextAttemptNumber = row.attempts + 1;
  // Bump attempt_number in the envelope so partners can see which retry
  // this is. Also recompute checksum since the body now includes the new
  // attempt number — wait, no: per the existing contract, checksum is
  // over `data` (the inner stringified JSON), not the envelope wrapper.
  // The data field is stable across retries. Keep checksum as-is.
  const retryEnvelope = {
    ...envelope,
    attempt_number: nextAttemptNumber,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RETRY_TIMEOUT_MS);
  let delivered = false;
  let status = 0;
  let errorMessage: string | undefined;

  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Karhoo-Request-Signature": envelope.checksum ?? "",
        "X-Exchange-Event-Id": envelope.id ?? "",
        "X-Exchange-Event-Type": envelope.event_type ?? "",
        "X-Exchange-Retry-Attempt": String(nextAttemptNumber),
      },
      body: JSON.stringify(retryEnvelope),
      signal: controller.signal,
    });
    status = res.status;
    delivered = res.ok;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      errorMessage = `${status} ${body.slice(0, 200)}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }

  if (delivered) {
    await db
      .update(webhookDeliveries)
      .set({
        outcome: "delivered",
        attempts: nextAttemptNumber,
        nextAttemptAt: null,
        processedAt: new Date(),
        // Mark the payload with the recovered-on-retry status so the
        // inspector can show "first delivered on attempt N" if useful.
        payload: sql`jsonb_set(${webhookDeliveries.payload}::jsonb, '{retry_succeeded_on_attempt}', to_jsonb(${nextAttemptNumber}::int))`,
      })
      .where(eq(webhookDeliveries.id, row.id));
    log.info("webhook retry succeeded", {
      area: "webhook-retry",
      delivery_id: row.id,
      attempt: nextAttemptNumber,
      status,
    });
    return "delivered";
  }

  // Failed. Either queue the next retry or flag if we've exhausted attempts.
  if (nextAttemptNumber >= MAX_DELIVERY_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({
        attempts: nextAttemptNumber,
        nextAttemptAt: null,
        flaggedAt: new Date(),
        processedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, row.id));
    log.warn("webhook retry exhausted — flagged for admin", {
      area: "webhook-retry",
      delivery_id: row.id,
      attempts: nextAttemptNumber,
      last_status: status,
      last_error: errorMessage,
    });
    return "flagged";
  }

  // Queue next retry. attempts is now the *number of* attempts done
  // (1-indexed). RETRY_INTERVALS_MS is 0-indexed and represents the
  // gap *after* attempt N — so the right index is (nextAttemptNumber - 1).
  const intervalMs =
    RETRY_INTERVALS_MS[nextAttemptNumber - 1] ??
    RETRY_INTERVALS_MS[RETRY_INTERVALS_MS.length - 1];
  await db
    .update(webhookDeliveries)
    .set({
      attempts: nextAttemptNumber,
      nextAttemptAt: new Date(Date.now() + intervalMs),
      processedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, row.id));
  log.info("webhook retry failed — next attempt queued", {
    area: "webhook-retry",
    delivery_id: row.id,
    attempt: nextAttemptNumber,
    last_status: status,
    next_attempt_in_ms: intervalMs,
  });
  return "retried_failed";
}
