import { db } from "@/db/client";
import {
  partners,
  partnerRules,
  transits,
  transitEvents,
  auditLog,
  networkControls,
} from "@/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { resolveFeeSnapshot } from "./fees";
import { getAdapterForPartner } from "@/adapters/registry";
import { reliabilityPenalty } from "./reliability";
import { captureError } from "./observability";
import type { NormalisedBooking } from "./types";
import type { FeeSnapshot } from "@/db/schema";

/**
 * Routing engine.
 *
 *   1. Eligibility: active + can-receive + mutual allow + vehicle/booking type
 *      match + pickup within partner's serviceRadiusKm of centroid.
 *   2. Score = fee * fee_weight + distanceKm * distance_weight. Closer and
 *      cheaper wins. Distance is weighted at 5p-per-km so a partner 2km
 *      closer is preferred over one 10p cheaper.
 *   3. Waterfall: try top candidate. On adapter failure, fall through to the
 *      next. Up to MAX_WATERFALL attempts. Every attempt recorded on
 *      transit.routingTrace.
 *
 * Idempotent on (originatorId, originatorBookingExternalId).
 */

const EARTH_RADIUS_KM = 6371;
const FEE_PER_PENCE_WEIGHT = 1;
const DISTANCE_KM_WEIGHT = 5;
const MAX_WATERFALL = 5;

/**
 * Acceptance windows — how long a recipient has between us pushing the
 * booking and them advancing it past `pushed` (to accepted or further). If
 * the window expires, recheckStaleAcceptances() reroutes to the next
 * candidate. Distinct windows for ASAP vs pre-book because pre-bookings are
 * less time-pressured.
 */
export const ASAP_ACCEPT_WINDOW_MS = 90_000;        // 90 seconds
export const PREBOOK_ACCEPT_WINDOW_MS = 5 * 60_000; // 5 minutes

export function acceptDeadlineFor(bookingType: "asap" | "prebook"): Date {
  const ms = bookingType === "prebook" ? PREBOOK_ACCEPT_WINDOW_MS : ASAP_ACCEPT_WINDOW_MS;
  return new Date(Date.now() + ms);
}

export async function routeBooking(args: {
  originatorPartnerId: string;
  booking: NormalisedBooking;
}): Promise<{ transitId: string; outcome: "pushed" | "no_match" | "paused" | "error" }> {
  const { originatorPartnerId, booking } = args;

  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  if (control?.killSwitch || process.env.NETWORK_KILL_SWITCH === "true") {
    const t = await insertTransit(originatorPartnerId, booking, "paused", { reason: "kill_switch" });
    return { transitId: t.id, outcome: "paused" };
  }

  const transit = await insertTransit(originatorPartnerId, booking, "routing", null);

  const candidates = await rankCandidates(originatorPartnerId, booking);
  if (candidates.length === 0) {
    await markTransit(transit.id, "no_match", { reason: "no_eligible_partner" });
    return { transitId: transit.id, outcome: "no_match" };
  }

  // Waterfall
  const attempts: Array<{
    recipientId: string;
    rank: number;
    score: number;
    distanceKm: number | null;
    receiveFeePence: number;
    acceptanceRate?: number | null;
    reliabilityPenaltyApplied?: number;
    outcome: "pushed" | "error_other" | "error_auth";
    error?: string;
  }> = [];

  let winnerRecipientId: string | null = null;
  let winnerFeeSnapshot: FeeSnapshot | null = null;
  let winnerExternalId: string | null = null;
  let winnerPartnershipCoid: string | null = null;
  let winnerRecipientClientId: string | null = null;
  let winnerRecipientServerName: string | null = null;
  let winnerRecipientSiteId: string | null = null;
  let winnerTrackMyTaxiLink: string | null = null;

  for (let i = 0; i < Math.min(MAX_WATERFALL, candidates.length); i++) {
    const c = candidates[i];
    try {
      const adapter = await getAdapterForPartner(c.recipientId);
      const result = await adapter.createBooking({
        transitId: transit.id,
        recipientPartnerId: c.recipientId,
        booking,
        feeSnapshot: c.fee,
      });
      attempts.push({
        recipientId: c.recipientId,
        rank: i,
        score: c.score,
        distanceKm: c.distanceKm,
        receiveFeePence: c.fee.receiveFeePence,
        acceptanceRate: c.acceptanceRate,
        reliabilityPenaltyApplied: c.reliabilityPenaltyApplied,
        outcome: "pushed",
      });
      winnerRecipientId = c.recipientId;
      winnerFeeSnapshot = c.fee;
      winnerExternalId = result.externalId;
      if (result.partnership) {
        winnerPartnershipCoid = result.partnership.coid ?? null;
        winnerRecipientClientId = result.partnership.clientId ?? null;
        winnerRecipientServerName = result.partnership.serverName ?? null;
        winnerRecipientSiteId = result.partnership.siteId ?? null;
      }
      if (result.trackMyTaxiLink) {
        winnerTrackMyTaxiLink = result.trackMyTaxiLink;
      }
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({
        recipientId: c.recipientId,
        rank: i,
        score: c.score,
        distanceKm: c.distanceKm,
        receiveFeePence: c.fee.receiveFeePence,
        acceptanceRate: c.acceptanceRate,
        reliabilityPenaltyApplied: c.reliabilityPenaltyApplied,
        outcome: /401|403|auth/i.test(msg) ? "error_auth" : "error_other",
        error: msg.slice(0, 200),
      });
      // continue to next candidate
    }
  }

  const routingTrace = {
    consideredCount: candidates.length,
    waterfallAttempts: attempts,
    winner: winnerRecipientId,
    pickupLat: booking.pickup.lat,
    pickupLng: booking.pickup.lng,
  };

  if (!winnerRecipientId || !winnerFeeSnapshot) {
    await db.update(transits).set({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: "error_other" as any,
      routingTrace,
      updatedAt: new Date(),
    }).where(eq(transits.id, transit.id));
    await db.insert(transitEvents).values({
      transitId: transit.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: "error_other" as any,
      detail: { reason: "all_candidates_failed", attempts: attempts.length },
      actor: "system",
    });
    return { transitId: transit.id, outcome: "error" };
  }

  await db.update(transits).set({
    recipientPartnerId: winnerRecipientId,
    recipientBookingExternalId: winnerExternalId,
    feeSnapshot: winnerFeeSnapshot,
    routingTrace,
    status: "pushed",
    partnershipCoid: winnerPartnershipCoid,
    recipientClientId: winnerRecipientClientId,
    recipientServerName: winnerRecipientServerName,
    recipientSiteId: winnerRecipientSiteId,
    trackMyTaxiLink: winnerTrackMyTaxiLink,
    acceptDeadline: acceptDeadlineFor(booking.bookingType),
    updatedAt: new Date(),
  }).where(eq(transits.id, transit.id));

  await db.insert(transitEvents).values({
    transitId: transit.id,
    status: "pushed",
    detail: {
      recipientBookingExternalId: winnerExternalId,
      waterfallAttempts: attempts.length,
    },
    actor: "system",
  });

  return { transitId: transit.id, outcome: "pushed" };
}

// ---------------------------------------------------------------------------
// Candidate ranking
// ---------------------------------------------------------------------------

export type RankedCandidate = {
  recipientId: string;
  fee: FeeSnapshot;
  distanceKm: number | null;
  /** Acceptance rate over last 7d. null = not enough data yet. */
  acceptanceRate: number | null;
  /** Sample size behind the rate. */
  totalPushed7d: number | null;
  /** Reliability term added to the score (0 if no penalty applied). */
  reliabilityPenaltyApplied: number;
  /** Score breakdown — useful for trace UI. */
  feeTerm: number;
  distanceTerm: number;
  score: number; // lower = better, sum of feeTerm + distanceTerm + reliabilityPenaltyApplied
};

export async function rankCandidates(
  originatorPartnerId: string,
  booking: NormalisedBooking,
): Promise<RankedCandidate[]> {
  const eligible = await findEligibleRecipients(originatorPartnerId, booking);
  if (eligible.length === 0) return [];

  const ranked: RankedCandidate[] = await Promise.all(
    eligible.map(async (p) => {
      const fee = await resolveFeeSnapshot(originatorPartnerId, p.id, booking);
      const distanceKm =
        p.centroidLat !== null && p.centroidLng !== null
          ? haversineKm(booking.pickup.lat, booking.pickup.lng, p.centroidLat, p.centroidLng)
          : null;
      // Partners without geo set get a neutral 25km — fee dominates for them.
      const effectiveDistance = distanceKm ?? 25;

      const feeTerm = fee.receiveFeePence * FEE_PER_PENCE_WEIGHT;
      const distanceTerm = effectiveDistance * DISTANCE_KM_WEIGHT;
      const reliabilityPenaltyApplied = reliabilityPenalty(p.acceptanceRate, p.totalPushed7d);
      const score = feeTerm + distanceTerm + reliabilityPenaltyApplied;

      return {
        recipientId: p.id,
        fee,
        distanceKm,
        acceptanceRate: p.acceptanceRate,
        totalPushed7d: p.totalPushed7d,
        reliabilityPenaltyApplied,
        feeTerm,
        distanceTerm,
        score,
      };
    }),
  );

  ranked.sort((a, b) => a.score - b.score);
  return ranked;
}

type EligiblePartner = {
  id: string;
  centroidLat: number | null;
  centroidLng: number | null;
  serviceRadiusKm: number | null;
  acceptanceRate: number | null;
  totalPushed7d: number | null;
};

async function findEligibleRecipients(
  originatorPartnerId: string,
  booking: NormalisedBooking,
): Promise<EligiblePartner[]> {
  // Look up the originator's kind for loop detection. If the originator is
  // an iCabbi-kind partner (i.e. H1.5 outbound flow — iCabbi handed us
  // overflow they couldn't fulfil), we MUST NOT route the booking back to
  // any iCabbi-kind partner. That would create a hot-potato loop: tenant A
  // has no driver → offers to The Exchange → we route to tenant B → tenant
  // B has no driver → offers to The Exchange → loops forever.
  //
  // Per STRATEGY.md decision #12 (virtual fleet identity) and the loop-
  // detection requirement in iCabbi BDD Epic 4 (Story 4.2).
  const [originator] = await db
    .select({ kind: partners.kind })
    .from(partners)
    .where(eq(partners.id, originatorPartnerId));
  const originatorKind = originator?.kind ?? null;
  const excludeAllICabbiPartners = originatorKind === "icabbi_fleet";

  const possible = await db
    .select()
    .from(partners)
    .where(
      and(
        eq(partners.status, "active"),
        or(
          eq(partners.participationMode, "receive_only"),
          eq(partners.participationMode, "send_and_receive"),
        ),
      ),
    );

  const candidateIds = possible
    .filter((p) => p.id !== originatorPartnerId)
    .filter((p) => !(excludeAllICabbiPartners && p.kind === "icabbi_fleet"))
    .map((p) => p.id);
  if (candidateIds.length === 0) return [];

  const outRules = await db
    .select()
    .from(partnerRules)
    .where(
      and(
        eq(partnerRules.originatorId, originatorPartnerId),
        inArray(partnerRules.recipientId, candidateIds),
      ),
    );
  const outAllowed = new Set(outRules.filter((r) => r.rule === "allow").map((r) => r.recipientId));

  const inRules = await db
    .select()
    .from(partnerRules)
    .where(
      and(
        eq(partnerRules.recipientId, originatorPartnerId),
        inArray(partnerRules.originatorId, candidateIds),
      ),
    );
  const inAllowed = new Set(inRules.filter((r) => r.rule === "allow").map((r) => r.originatorId));

  return possible
    .filter((p) => p.id !== originatorPartnerId)
    .filter((p) => !(excludeAllICabbiPartners && p.kind === "icabbi_fleet"))
    .filter((p) => outAllowed.has(p.id) && inAllowed.has(p.id))
    .filter((p) => p.bookingTypes.includes(booking.bookingType))
    .filter((p) => p.vehicleTypes.length === 0 || p.vehicleTypes.includes(booking.vehicleType))
    .filter((p) => isWithinServiceArea(p, booking))
    .map((p) => ({
      id: p.id,
      centroidLat: p.centroidLat,
      centroidLng: p.centroidLng,
      acceptanceRate: p.acceptanceRate,
      totalPushed7d: p.totalPushed7d,
      serviceRadiusKm: p.serviceRadiusKm,
    }));
}

/** Partners without geo data are treated as covering everywhere (back-compat). */
function isWithinServiceArea(
  p: { centroidLat: number | null; centroidLng: number | null; serviceRadiusKm: number | null },
  booking: NormalisedBooking,
): boolean {
  if (p.centroidLat === null || p.centroidLng === null || p.serviceRadiusKm === null) return true;
  const distance = haversineKm(booking.pickup.lat, booking.pickup.lng, p.centroidLat, p.centroidLng);
  return distance <= p.serviceRadiusKm;
}

/** Great-circle distance in km between two lat/lng pairs. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function insertTransit(
  originatorPartnerId: string,
  booking: NormalisedBooking,
  status: "routing" | "paused" | "received",
  detail: Record<string, unknown> | null,
) {
  const existing = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.originatorPartnerId, originatorPartnerId),
        eq(transits.originatorBookingExternalId, booking.originatorBookingExternalId),
      ),
    );

  if (existing[0]) return existing[0];

  const [row] = await db
    .insert(transits)
    .values({
      originatorPartnerId,
      originatorBookingExternalId: booking.originatorBookingExternalId,
      status,
      bookingPayload: booking as unknown as Record<string, unknown>,
    })
    .returning();

  await db.insert(transitEvents).values({
    transitId: row.id,
    status,
    detail,
    actor: "system",
  });

  return row;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markTransit(transitId: string, status: any, detail: Record<string, unknown>) {
  await db.update(transits).set({ status, updatedAt: new Date() }).where(eq(transits.id, transitId));
  await db.insert(transitEvents).values({ transitId, status, detail, actor: "system" });
}

// ---------------------------------------------------------------------------
// Status update + kill switch
// ---------------------------------------------------------------------------

export async function forwardStatusUpdate(args: {
  transitId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newStatus: any;
  detail?: Record<string, unknown>;
}) {
  const { transitId, newStatus, detail } = args;
  // When the booking advances past 'pushed' we clear the accept-deadline —
  // the recipient committed in time, so the auto-reroute job can ignore it.
  // Leave the deadline in place if the new status is 'pushed' itself
  // (shouldn't happen via this path but be defensive).
  const clearDeadline = newStatus !== "pushed" && newStatus !== "routing";
  await db.update(transits).set({
    status: newStatus,
    updatedAt: new Date(),
    ...(clearDeadline ? { acceptDeadline: null } : {}),
  }).where(eq(transits.id, transitId));
  await db.insert(transitEvents).values({
    transitId,
    status: newStatus,
    detail,
    actor: "partner_webhook",
  });

  const [t] = await db.select().from(transits).where(eq(transits.id, transitId));
  if (t) {
    console.log(
      `[forwardStatusUpdate] transit=${transitId} originator=${t.originatorPartnerId} ` +
        `originatorBookingId=${t.originatorBookingExternalId} status=${newStatus}`,
    );
  }
}

/**
 * Type returned by setKillSwitch to surface the resume outcome to callers.
 * `resumed` is only populated when toggling the switch OFF — it tells the
 * caller how many paused transits got re-routed and what happened to each.
 */
export type SetKillSwitchResult = {
  /** New state of the switch. */
  on: boolean;
  /** Only populated when `on === false` and we ran the resume. */
  resumed?: {
    scanned: number;
    pushed: number;
    no_match: number;
    paused: number;
    error: number;
  };
};

export async function setKillSwitch(
  on: boolean,
  reason: string,
  actor: string,
): Promise<SetKillSwitchResult> {
  const [existing] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  const before = existing ?? null;
  const after = {
    id: "global" as const,
    killSwitch: on,
    killSwitchReason: reason,
    killSwitchToggledAt: new Date(),
    killSwitchToggledBy: actor,
  };

  if (existing) {
    await db.update(networkControls).set(after).where(eq(networkControls.id, "global"));
  } else {
    await db.insert(networkControls).values(after);
  }

  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: actor,
    action: on ? "kill_switch.on" : "kill_switch.off",
    subjectType: "network",
    subjectId: "global",
    before,
    after,
  });

  // When the switch goes OFF, replay paused transits so they don't strand.
  // Dynamic import to avoid the circular dependency with lib/reroute.ts.
  if (!on) {
    try {
      const { resumePausedTransits } = await import("@/lib/reroute");
      const resumed = await resumePausedTransits(actor);
      if (resumed.scanned > 0) {
        console.log(
          `[kill_switch.off] resumed ${resumed.scanned} paused transit(s): ` +
            `pushed=${resumed.pushed} no_match=${resumed.no_match} error=${resumed.error}`,
        );
      }
      return { on, resumed };
    } catch (err) {
      // Don't fail the kill-switch toggle if resume blows up. Log the error
      // and the admin can manually resume via the upcoming admin button.
      captureError(err, { area: "kill_switch_off_resume" });
    }
  }

  return { on };
}

// ---------------------------------------------------------------------------
// Async routing (P0-3) — receive + drain
// ---------------------------------------------------------------------------
//
// Inbound webhook handlers call `receiveBooking()` instead of `routeBooking()`:
// it writes the transit at status='received' in a few ms, then returns. The
// actual routing happens on a background drain (`processReceivedTransits()`).
// The webhook can 200 ack the partner in under 100ms even if routing requires
// chained HTTP calls to recipient adapters.
//
// `routeBooking()` is still used by synchronous callers (fire-jobs script,
// the test booking form, the admin retry button) where waiting for the full
// routing outcome is the point.
//
// At pilot scale this is a Postgres-polling drain triggered by Vercel cron
// every minute (and by the demo background tick locally). When traffic grows
// beyond ~1000 bookings/minute, swap the drain for Inngest or Trigger.dev
// using the same `processReceivedTransits()` signature — only the trigger
// changes, not the work itself.

/**
 * Record a booking arriving from an originator and return immediately. The
 * routing engine processes it asynchronously via `processReceivedTransits`.
 *
 * Idempotent on (originator, originatorBookingExternalId) — duplicate inbound
 * deliveries return the existing transit with outcome='duplicate'.
 *
 * Kill-switch aware: when engaged, the transit lands at 'paused' rather than
 * 'received'. The kill-switch-off resume engine picks it up like any other
 * paused row.
 */
export async function receiveBooking(args: {
  originatorPartnerId: string;
  booking: NormalisedBooking;
}): Promise<{ transitId: string; outcome: "received" | "duplicate" | "paused" }> {
  const { originatorPartnerId, booking } = args;

  // Idempotency first — saves a DB write when the partner retries.
  const existing = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.originatorPartnerId, originatorPartnerId),
        eq(transits.originatorBookingExternalId, booking.originatorBookingExternalId),
      ),
    );

  if (existing[0]) {
    return { transitId: existing[0].id, outcome: "duplicate" };
  }

  // Kill-switch aware
  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  const killed = control?.killSwitch || process.env.NETWORK_KILL_SWITCH === "true";
  const status: "received" | "paused" = killed ? "paused" : "received";

  const transit = await insertTransit(
    originatorPartnerId,
    booking,
    status,
    killed ? { reason: "kill_switch" } : { source: "webhook_ingest" },
  );

  return { transitId: transit.id, outcome: status };
}

/**
 * Background drain: claim received transits, run the routing engine on each,
 * return aggregate outcomes. Designed to be called by a Vercel cron OR the
 * demo tick — both safe.
 *
 * Concurrency safety: each transit is claimed via a conditional UPDATE
 * (`status='received' → 'routing'`) that returns the row only if the
 * transition happened. Two concurrent workers grabbing the same row will
 * see exactly one succeed; the other skips.
 */
export async function processReceivedTransits(
  limit = 20,
): Promise<{
  scanned: number;
  pushed: number;
  no_match: number;
  paused: number;
  error: number;
  skipped: number;
}> {
  const received = await db
    .select()
    .from(transits)
    .where(eq(transits.status, "received"))
    .orderBy(transits.createdAt) // FIFO
    .limit(limit);

  const outcomes = { scanned: received.length, pushed: 0, no_match: 0, paused: 0, error: 0, skipped: 0 };

  for (const t of received) {
    try {
      // Claim the row — fail silently if another worker beat us to it
      const claim = await db
        .update(transits)
        .set({ status: "routing", updatedAt: new Date() })
        .where(and(eq(transits.id, t.id), eq(transits.status, "received")))
        .returning({ id: transits.id });
      if (claim.length === 0) {
        outcomes.skipped++;
        continue;
      }

      const booking = t.bookingPayload as unknown as NormalisedBooking;
      const result = await routeBooking({
        originatorPartnerId: t.originatorPartnerId,
        booking,
      });
      outcomes[result.outcome]++;
    } catch (err) {
      outcomes.error++;
      captureError(err, { area: "process_queue", transit_id: t.id });
    }
  }

  return outcomes;
}
