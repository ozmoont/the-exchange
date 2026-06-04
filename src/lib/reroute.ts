/**
 * Acceptance-window enforcement + auto-reroute.
 *
 * When `routeBooking()` pushes a booking to a recipient it sets an
 * acceptDeadline on the transit (90s ASAP / 5min pre-book). If the recipient
 * doesn't advance the booking past `pushed` before that deadline,
 * `recheckStaleAcceptances()`:
 *
 *   1. Cancels the booking on the original recipient (best-effort)
 *   2. Finds the next eligible candidate, excluding everyone we've already
 *      tried for this transit
 *   3. Pushes to that candidate
 *   4. Records the new attempt on routingTrace
 *   5. Increments rerouteCount
 *
 * If no candidates remain we drop the transit to `no_match`. The originator's
 * webhook gets a status update either way.
 *
 * This is the biggest product differentiator over iCabbi's native partnership
 * coid mechanism — that protocol can't reroute, it only delivers one hop.
 *
 * In production this runs as a Vercel cron every minute. Today it's invoked
 * from the demo-mode background tick (same cadence as the lifecycle ticker).
 */

import { db } from "@/db/client";
import { transits, transitEvents, auditLog, partners } from "@/db/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { getAdapterForPartner } from "@/adapters/registry";
import { rankCandidates, acceptDeadlineFor, forwardStatusUpdate, routeBooking } from "@/lib/routing";
import { resolveFeeSnapshot } from "@/lib/fees";
import { captureError } from "@/lib/observability";
import { log } from "@/lib/logger";
import type { NormalisedBooking } from "@/lib/types";
import type { FeeSnapshot } from "@/db/schema";

const MAX_REROUTE_ATTEMPTS = 5;

type RerouteOutcome = {
  transitId: string;
  outcome: "rerouted" | "no_more_candidates" | "max_attempts" | "error";
  newRecipientId?: string;
  error?: string;
};

/**
 * Scan for transits past their acceptDeadline and reroute each one.
 * Safe to call repeatedly — idempotent on already-completed bookings
 * because they have no deadline.
 *
 * Returns the per-transit outcomes for logging / monitoring.
 */
export async function recheckStaleAcceptances(): Promise<RerouteOutcome[]> {
  const stale = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.status, "pushed"),
        isNotNull(transits.acceptDeadline),
        lt(transits.acceptDeadline, new Date()),
      ),
    )
    .limit(50);

  if (stale.length === 0) return [];

  const outcomes: RerouteOutcome[] = [];
  for (const t of stale) {
    try {
      const outcome = await rerouteOne(t);
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        transitId: t.id,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

async function rerouteOne(t: typeof transits.$inferSelect): Promise<RerouteOutcome> {
  if (t.rerouteCount >= MAX_REROUTE_ATTEMPTS) {
    // We've tried enough. Mark as failed and stop.
    await forwardStatusUpdate({
      transitId: t.id,
      newStatus: "failed" as never,
      detail: { reason: "max_reroute_attempts", attemptsSoFar: t.rerouteCount },
    });
    return { transitId: t.id, outcome: "max_attempts" };
  }

  // 1. Cancel on the original recipient — best-effort, log only if fails.
  if (t.recipientPartnerId && t.recipientBookingExternalId) {
    try {
      const originalAdapter = await getAdapterForPartner(t.recipientPartnerId);
      await originalAdapter.cancelBooking({
        externalId: t.recipientBookingExternalId,
        reason: "accept_window_expired",
      });
    } catch (cancelErr) {
      // The recipient might be down. Carry on — they can clean up locally if/when
      // they come back. We've already moved the booking off their side.
      log.warn("reroute cancel-on-original failed", {
        transit_id: t.id,
        err: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
      });
    }
  }

  // 2. Find next eligible candidate, excluding every partner we've already attempted.
  const booking = t.bookingPayload as unknown as NormalisedBooking;
  const trace = (t.routingTrace ?? {}) as {
    waterfallAttempts?: Array<{ recipientId: string }>;
    rerouteAttempts?: Array<{ recipientId: string; reason: string; at: string }>;
  };
  const excluded = new Set<string>();
  for (const a of trace.waterfallAttempts ?? []) excluded.add(a.recipientId);
  for (const r of trace.rerouteAttempts ?? []) excluded.add(r.recipientId);
  if (t.recipientPartnerId) excluded.add(t.recipientPartnerId);

  const ranked = await rankCandidates(t.originatorPartnerId, booking);
  const remaining = ranked.filter((c) => !excluded.has(c.recipientId));

  if (remaining.length === 0) {
    await db
      .update(transits)
      .set({
        status: "no_match",
        acceptDeadline: null,
        routingTrace: {
          ...trace,
          rerouteAttempts: [
            ...(trace.rerouteAttempts ?? []),
            {
              recipientId: t.recipientPartnerId ?? "(unknown)",
              reason: "no_more_candidates",
              at: new Date().toISOString(),
            },
          ],
        },
        updatedAt: new Date(),
      })
      .where(eq(transits.id, t.id));

    await db.insert(transitEvents).values({
      transitId: t.id,
      status: "no_match",
      detail: { reason: "accept_window_expired_no_candidates", rerouteCount: t.rerouteCount },
      actor: "system",
    });

    return { transitId: t.id, outcome: "no_more_candidates" };
  }

  // 3. Try the next candidate.
  const next = remaining[0];
  let pushedExternalId: string | null = null;
  let pushedFee: FeeSnapshot | null = null;
  let pushedError: string | null = null;

  try {
    const adapter = await getAdapterForPartner(next.recipientId);
    const result = await adapter.createBooking({
      transitId: t.id,
      recipientPartnerId: next.recipientId,
      booking,
      feeSnapshot: next.fee,
    });
    pushedExternalId = result.externalId;
    pushedFee = next.fee;
  } catch (err) {
    pushedError = err instanceof Error ? err.message : String(err);
  }

  // Re-resolve fee for snapshot accuracy on the new pair (might differ if pair
  // override exists). For now we use the ranked fee but if you want a fresh
  // snapshot, call resolveFeeSnapshot here.
  void resolveFeeSnapshot;

  const rerouteEntry = {
    recipientId: next.recipientId,
    rank: next.score,
    distanceKm: next.distanceKm,
    receiveFeePence: next.fee.receiveFeePence,
    reason: "accept_window_expired",
    at: new Date().toISOString(),
    success: pushedError === null,
    ...(pushedError ? { error: pushedError } : {}),
  };

  if (pushedError) {
    // This candidate also failed. Don't mark the transit, just record the
    // attempt and let the next recheck try the next one in line.
    await db
      .update(transits)
      .set({
        routingTrace: {
          ...trace,
          rerouteAttempts: [...(trace.rerouteAttempts ?? []), rerouteEntry],
        },
        // Push the deadline forward so we don't reroute again on the same tick.
        acceptDeadline: acceptDeadlineFor(booking.bookingType),
        updatedAt: new Date(),
      })
      .where(eq(transits.id, t.id));
    return { transitId: t.id, outcome: "error", newRecipientId: next.recipientId, error: pushedError };
  }

  // 4. Success — update transit to the new recipient.
  await db
    .update(transits)
    .set({
      recipientPartnerId: next.recipientId,
      recipientBookingExternalId: pushedExternalId,
      feeSnapshot: pushedFee,
      status: "pushed",
      rerouteCount: t.rerouteCount + 1,
      acceptDeadline: acceptDeadlineFor(booking.bookingType),
      routingTrace: {
        ...trace,
        rerouteAttempts: [...(trace.rerouteAttempts ?? []), rerouteEntry],
      },
      updatedAt: new Date(),
    })
    .where(eq(transits.id, t.id));

  await db.insert(transitEvents).values({
    transitId: t.id,
    status: "pushed",
    detail: {
      kind: "rerouted_after_accept_timeout",
      newRecipientId: next.recipientId,
      rerouteCount: t.rerouteCount + 1,
    },
    actor: "system",
  });

  // Audit-log the rerouting decision so super admins can review them
  const [newPartner] = await db.select().from(partners).where(eq(partners.id, next.recipientId));
  const [previousPartner] = t.recipientPartnerId
    ? await db.select().from(partners).where(eq(partners.id, t.recipientPartnerId))
    : [null];
  await db.insert(auditLog).values({
    category: "booking",
    actor: "system",
    actorRef: "reroute_engine",
    action: "transit.rerouted",
    subjectType: "transit",
    subjectId: t.id,
    before: { recipientPartnerId: t.recipientPartnerId },
    after: {
      recipientPartnerId: next.recipientId,
      recipientName: newPartner?.name ?? null,
      reason: "accept_window_expired",
      rerouteCount: t.rerouteCount + 1,
    },
  });

  // Gap #3 — notify the demand fleet so their dispatch / passenger app can
  // react to the change in fulfilling partner. Fire-and-forget; failures are
  // recorded in webhook_deliveries via the helper itself.
  try {
    const { sendOutboundEvent } = await import("@/lib/outbound-webhooks");
    await sendOutboundEvent(t.originatorPartnerId, "transit.rerouted", {
      originatorBookingExternalId: t.originatorBookingExternalId,
      transitId: t.id,
      previous_recipient: t.recipientPartnerId
        ? { id: t.recipientPartnerId, name: previousPartner?.name ?? null }
        : null,
      new_recipient: {
        id: next.recipientId,
        name: newPartner?.name ?? null,
      },
      reason: "accept_window_expired",
      reroute_count: t.rerouteCount + 1,
      occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    log.warn("reroute outbound event failed", {
      transit_id: t.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return { transitId: t.id, outcome: "rerouted", newRecipientId: next.recipientId };
}

// ---------------------------------------------------------------------------
// Kill-switch resume — Gap #1 in FAILURE_MODES.md
// ---------------------------------------------------------------------------
//
// When the kill switch engages, new bookings get parked at status='paused'.
// When it disengages, we replay routeBooking() on every paused transit so
// they don't strand. routeBooking is idempotent on
// (originator, originatorBookingExternalId) — `insertTransit` returns the
// existing row instead of creating a duplicate — so calling it again just
// updates the same transit row in place.
//
// Outcomes: each paused transit ends up in one of {pushed, no_match, paused,
// error}. If routing still fails on the second try (e.g. fleet that would
// have taken it has since suspended), the transit progresses to its honest
// terminal state. We never leave bookings stranded at 'paused' once the
// kill switch is off.

export type ResumeOutcomes = {
  scanned: number;
  pushed: number;
  no_match: number;
  paused: number; // re-paused — kill switch flipped back on between scan and route
  error: number;
};

export async function resumePausedTransits(actor: string): Promise<ResumeOutcomes> {
  const paused = await db
    .select()
    .from(transits)
    .where(eq(transits.status, "paused"))
    .limit(500);

  const outcomes: ResumeOutcomes = {
    scanned: paused.length,
    pushed: 0,
    no_match: 0,
    paused: 0,
    error: 0,
  };

  for (const t of paused) {
    try {
      const booking = t.bookingPayload as unknown as NormalisedBooking;
      const result = await routeBooking({
        originatorPartnerId: t.originatorPartnerId,
        booking,
      });
      outcomes[result.outcome]++;

      await db.insert(auditLog).values({
        category: "booking",
        actor: "system",
        actorRef: actor,
        action: "transit.resumed_from_paused",
        subjectType: "transit",
        subjectId: t.id,
        before: { status: "paused" },
        after: { outcome: result.outcome },
      });
    } catch (err) {
      outcomes.error++;
      captureError(err, { area: "resume_paused", transit_id: t.id });
    }
  }

  return outcomes;
}
