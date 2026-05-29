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

/**
 * Routing engine. Given a booking received from an originator, pick an eligible
 * recipient and push the booking via the recipient's adapter. Idempotent on
 * (originatorId, originatorBookingExternalId).
 *
 * Returns the transit id whether the route succeeded, failed, or was paused.
 */
export async function routeBooking(args: {
  originatorPartnerId: string;
  booking: NormalisedBooking;
}): Promise<{ transitId: string; outcome: "pushed" | "no_match" | "paused" | "error" }> {
  const { originatorPartnerId, booking } = args;

  // 1. Network-wide kill switch check
  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  if (control?.killSwitch || process.env.NETWORK_KILL_SWITCH === "true") {
    const t = await insertTransit(originatorPartnerId, booking, "paused", { reason: "kill_switch" });
    return { transitId: t.id, outcome: "paused" };
  }

  // 2. Idempotency: insert-or-fetch transit
  const transit = await insertTransit(originatorPartnerId, booking, "routing", null);

  // 3. Find eligible recipients
  const eligible = await findEligibleRecipients(originatorPartnerId, booking);
  if (eligible.length === 0) {
    await markTransit(transit.id, "no_match", { reason: "no_eligible_partner" });
    return { transitId: transit.id, outcome: "no_match" };
  }

  // 4. Pick recipient (MVP: lowest receive_fee. Future: scoring, traffic light, priority list.)
  const candidates = await Promise.all(
    eligible.map(async (recipientId) => {
      const fee = await resolveFeeSnapshot(originatorPartnerId, recipientId, booking);
      return { recipientId, fee };
    }),
  );
  candidates.sort((a, b) => a.fee.receiveFeePence - b.fee.receiveFeePence);
  const winner = candidates[0];

  // 5. Push to recipient via their adapter
  try {
    const adapter = await getAdapterForPartner(winner.recipientId);
    const result = await adapter.createBooking({
      transitId: transit.id,
      recipientPartnerId: winner.recipientId,
      booking,
      feeSnapshot: winner.fee,
    });

    await db
      .update(transits)
      .set({
        recipientPartnerId: winner.recipientId,
        recipientBookingExternalId: result.externalId,
        feeSnapshot: winner.fee,
        routingTrace: {
          consideredCount: candidates.length,
          winner: winner.recipientId,
          ranking: candidates.map((c) => ({ id: c.recipientId, receiveFeePence: c.fee.receiveFeePence })),
        },
        status: "pushed",
        updatedAt: new Date(),
      })
      .where(eq(transits.id, transit.id));

    await db.insert(transitEvents).values({
      transitId: transit.id,
      status: "pushed",
      detail: { recipientBookingExternalId: result.externalId },
      actor: "system",
    });

    return { transitId: transit.id, outcome: "pushed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markTransit(transit.id, "error_other", { error: msg });
    return { transitId: transit.id, outcome: "error" };
  }
}

async function insertTransit(
  originatorPartnerId: string,
  booking: NormalisedBooking,
  status: "routing" | "paused",
  detail: Record<string, unknown> | null,
) {
  // Upsert by (originator, externalId) — idempotent inbound webhooks
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

async function markTransit(transitId: string, status: any, detail: Record<string, unknown>) {
  await db.update(transits).set({ status, updatedAt: new Date() }).where(eq(transits.id, transitId));
  await db.insert(transitEvents).values({ transitId, status, detail, actor: "system" });
}

/**
 * Eligibility:
 *  - partner.status = "active"
 *  - participationMode in ("receive_only", "send_and_receive")
 *  - mutual allow rule: (originator, recipient, allow) AND (recipient, originator, allow)
 *  - vehicleType matches (if recipient enforces a list)
 *  - bookingType matches recipient's accepted types
 *  - (zone matching deliberately stubbed in MVP — TODO when we have proper geo)
 */
async function findEligibleRecipients(
  originatorPartnerId: string,
  booking: NormalisedBooking,
): Promise<string[]> {
  // All active partners that can receive
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

  // Rules: originator -> candidate must be allow
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

  // Rules: candidate -> originator must also be allow (mutual)
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
    .map((p) => p.id);
}

/**
 * Forward a status update from the recipient back to the originator. Used by
 * the /api/webhooks/status route handler.
 */
export async function forwardStatusUpdate(args: {
  transitId: string;
  newStatus: any;
  detail?: Record<string, unknown>;
}) {
  const { transitId, newStatus, detail } = args;
  await db.update(transits).set({ status: newStatus, updatedAt: new Date() }).where(eq(transits.id, transitId));
  await db.insert(transitEvents).values({
    transitId,
    status: newStatus,
    detail,
    actor: "partner_webhook",
  });

  // Forward to originator. In a real adapter this would POST to the originator's
  // status-update webhook URL. The mock just logs.
  const [t] = await db.select().from(transits).where(eq(transits.id, transitId));
  if (t) {
    console.log(
      `[forwardStatusUpdate] transit=${transitId} originator=${t.originatorPartnerId} ` +
        `originatorBookingId=${t.originatorBookingExternalId} status=${newStatus}`,
    );
  }
}

/**
 * Network-wide kill switch toggle.
 */
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
