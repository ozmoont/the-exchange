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
  score: number; // lower = better
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
      const score =
        fee.receiveFeePence * FEE_PER_PENCE_WEIGHT + effectiveDistance * DISTANCE_KM_WEIGHT;
      return { recipientId: p.id, fee, distanceKm, score };
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
};

async function findEligibleRecipients(
  originatorPartnerId: string,
  booking: NormalisedBooking,
): Promise<EligiblePartner[]> {
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

  const candidateIds = possible.filter((p) => p.id !== originatorPartnerId).map((p) => p.id);
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
    .filter((p) => outAllowed.has(p.id) && inAllowed.has(p.id))
    .filter((p) => p.bookingTypes.includes(booking.bookingType))
    .filter((p) => p.vehicleTypes.length === 0 || p.vehicleTypes.includes(booking.vehicleType))
    .filter((p) => isWithinServiceArea(p, booking))
    .map((p) => ({
      id: p.id,
      centroidLat: p.centroidLat,
      centroidLng: p.centroidLng,
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
  status: "routing" | "paused",
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

export async function setKillSwitch(on: boolean, reason: string, actor: string) {
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
}
