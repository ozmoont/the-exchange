import { db } from "@/db/client";
import { feeConfigs, type FeeSnapshot } from "@/db/schema";
import { and, eq, isNull, or, lte, gte, desc } from "drizzle-orm";
import type { NormalisedBooking } from "./types";

/**
 * Resolve the fee snapshot for a given originator->recipient transit at the
 * moment of routing. Resolution order:
 *   1. Pair-specific config (originator, recipient)
 *   2. Recipient-level default config
 *   3. Hard-coded system default (£0.20 send, £0.40 receive, no trip fees)
 *
 * Snapshot is non-retroactive: once written onto the transit, never changes.
 */
export async function resolveFeeSnapshot(
  originatorId: string,
  recipientId: string,
  booking: NormalisedBooking,
): Promise<FeeSnapshot> {
  const now = new Date();

  // Pair-specific
  const pair = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.scope, "pair"),
        eq(feeConfigs.originatorId, originatorId),
        eq(feeConfigs.recipientId, recipientId),
        lte(feeConfigs.effectiveFrom, now),
        or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeConfigs.effectiveFrom))
    .limit(1);

  // Recipient default
  const def = pair.length
    ? []
    : await db
        .select()
        .from(feeConfigs)
        .where(
          and(
            eq(feeConfigs.scope, "partner"),
            eq(feeConfigs.recipientId, recipientId),
            lte(feeConfigs.effectiveFrom, now),
            or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
          ),
        )
        .orderBy(desc(feeConfigs.effectiveFrom))
        .limit(1);

  const cfg = pair[0] ?? def[0];

  if (!cfg) {
    return makeSnapshot(systemDefault(), "system_default", booking);
  }

  // Channel applicability
  if (!cfg.applyToChannels.includes(booking.channel)) {
    return makeSnapshot(systemDefault(), "system_default_channel_skip", booking);
  }

  // Booking type applicability
  if (booking.bookingType === "asap" && !cfg.applyToAsap) {
    return makeSnapshot(systemDefault(), "system_default_asap_skip", booking);
  }
  if (booking.bookingType === "prebook" && !cfg.applyToPrebook) {
    return makeSnapshot(systemDefault(), "system_default_prebook_skip", booking);
  }

  return makeSnapshot(cfg, cfg.id, booking);
}

/**
 * Pure helpers. Exported so unit tests can exercise the fee math without
 * touching the database. `resolveFeeSnapshot` above is the db-backed wrapper.
 */
export function systemDefault() {
  return {
    sendFeePence: 20,
    receiveFeePence: 40,
    techFeePence: 0,
    techFeeBps: 0,
    bookingFeePence: 0,
    adminFeePence: 0,
    adminFeeBps: 0,
  };
}

export function makeSnapshot(
  raw: ReturnType<typeof systemDefault> | typeof feeConfigs.$inferSelect,
  resolvedFromFeeConfigId: string,
  booking: NormalisedBooking,
): FeeSnapshot {
  const fare = booking.fareEstimatePence ?? 0;
  const tech = raw.techFeePence + Math.round((fare * raw.techFeeBps) / 10000);
  const admin = raw.adminFeePence + Math.round((fare * raw.adminFeeBps) / 10000);
  const computedPassengerAddOnsPence = tech + raw.bookingFeePence + admin;
  return {
    sendFeePence: raw.sendFeePence,
    receiveFeePence: raw.receiveFeePence,
    techFeePence: raw.techFeePence,
    techFeeBps: raw.techFeeBps,
    bookingFeePence: raw.bookingFeePence,
    adminFeePence: raw.adminFeePence,
    adminFeeBps: raw.adminFeeBps,
    computedPassengerAddOnsPence,
    fareAtSnapshotPence: booking.fareEstimatePence ?? null,
    resolvedFromFeeConfigId,
  };
}
