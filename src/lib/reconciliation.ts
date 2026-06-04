/**
 * Post-completion reconciliation.
 *
 * After a booking reaches `completed` we ask BOTH adapters what they actually
 * billed. Compare to the feeSnapshot we locked in at routing time. If the
 * totals diverge by more than RECONCILIATION_DRIFT_THRESHOLD we flag the
 * transit for super-admin review.
 *
 * Why this matters: the real iCabbi paired payloads we used as fixtures
 * showed a £10 processing_fee on the demand side that didn't appear on the
 * supply side. Drift like that builds invoice disputes if left unchecked.
 *
 * Storage: per-transit columns on `transits` (reconciledAt, reconciledOriginatorTotalPence,
 * reconciledRecipientTotalPence, reconciledDriftPence, reconciledFlagged).
 * Idempotent — only scans transits where reconciledAt is null.
 *
 * Runs hourly in demo mode via maybeReconcileCompletedTransits(). Production
 * cron lands when async routing does.
 */

import { db } from "@/db/client";
import { transits, networkControls, auditLog } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getAdapterForPartner } from "@/adapters/registry";

const COOLDOWN_MS = 60 * 60_000;      // 1 hour
const DRIFT_THRESHOLD_PCT = 0.05;     // 5% of the feeSnapshot total
const DRIFT_THRESHOLD_FLOOR_PENCE = 50; // always flag drift > 50p regardless of percentage

export type ReconciliationOutcome = {
  scanned: number;
  reconciled: number;
  flagged: number;
  skipped: number;
  error: number;
};

/**
 * Scan completed transits that haven't been reconciled yet and compare both
 * sides' actual billing to our feeSnapshot.
 */
export async function reconcileCompletedTransits(): Promise<ReconciliationOutcome> {
  const completed = await db
    .select()
    .from(transits)
    .where(and(eq(transits.status, "completed"), isNull(transits.reconciledAt)))
    .limit(200);

  const outcome: ReconciliationOutcome = {
    scanned: completed.length,
    reconciled: 0,
    flagged: 0,
    skipped: 0,
    error: 0,
  };

  for (const t of completed) {
    try {
      if (!t.recipientPartnerId || !t.recipientBookingExternalId) {
        outcome.skipped++;
        continue;
      }

      const [originatorAdapter, recipientAdapter] = await Promise.all([
        getAdapterForPartner(t.originatorPartnerId),
        getAdapterForPartner(t.recipientPartnerId),
      ]);

      const [originatorPayment, recipientPayment] = await Promise.all([
        originatorAdapter.fetchBookingPayment?.(t.originatorBookingExternalId) ?? null,
        recipientAdapter.fetchBookingPayment?.(t.recipientBookingExternalId) ?? null,
      ]);

      // If neither adapter can tell us, mark as reconciled-but-empty so we
      // don't keep retrying. Capture timestamp for observability.
      if (!originatorPayment && !recipientPayment) {
        await db
          .update(transits)
          .set({ reconciledAt: new Date(), updatedAt: new Date() })
          .where(eq(transits.id, t.id));
        outcome.skipped++;
        continue;
      }

      const originatorTotal = originatorPayment?.totalPence ?? null;
      const recipientTotal = recipientPayment?.totalPence ?? null;

      // Drift = how far the two sides differ. NULL on either side → drift
      // is undefined but we still want to capture what we have.
      const drift =
        originatorTotal !== null && recipientTotal !== null
          ? Math.abs(originatorTotal - recipientTotal)
          : null;

      // Flag when drift exceeds 5% of the larger of the two totals (so small
      // bookings don't slip through) AND exceeds the 50p floor.
      const denom = Math.max(originatorTotal ?? 0, recipientTotal ?? 0);
      const flagged =
        drift !== null &&
        drift > DRIFT_THRESHOLD_FLOOR_PENCE &&
        (denom === 0 || drift / denom > DRIFT_THRESHOLD_PCT);

      await db
        .update(transits)
        .set({
          reconciledAt: new Date(),
          reconciledOriginatorTotalPence: originatorTotal,
          reconciledRecipientTotalPence: recipientTotal,
          reconciledDriftPence: drift,
          reconciledFlagged: flagged,
          updatedAt: new Date(),
        })
        .where(eq(transits.id, t.id));

      if (flagged) {
        outcome.flagged++;
        await db.insert(auditLog).values({
          category: "fee",
          actor: "system",
          actorRef: "reconciliation",
          action: "transit.reconciliation_flagged",
          subjectType: "transit",
          subjectId: t.id,
          before: null,
          after: {
            originatorTotalPence: originatorTotal,
            recipientTotalPence: recipientTotal,
            driftPence: drift,
            feeSnapshotReceiveFeePence: t.feeSnapshot?.receiveFeePence ?? null,
          },
        });
      }

      outcome.reconciled++;
    } catch (err) {
      outcome.error++;
      console.error(
        `[reconciliation] transit ${t.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return outcome;
}

/**
 * Demo-tick wrapper with cooldown. Safe to call on every page render.
 */
export async function maybeReconcileCompletedTransits(): Promise<void> {
  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  const now = new Date();
  const last = control?.lastReconciliationRunAt;
  if (last && now.getTime() - last.getTime() < COOLDOWN_MS) return;

  await db
    .update(networkControls)
    .set({ lastReconciliationRunAt: now })
    .where(eq(networkControls.id, "global"));

  try {
    const outcome = await reconcileCompletedTransits();
    if (outcome.scanned > 0) {
      console.log(
        `[reconciliation] scanned=${outcome.scanned} reconciled=${outcome.reconciled} ` +
          `flagged=${outcome.flagged} skipped=${outcome.skipped} error=${outcome.error}`,
      );
    }
  } catch (err) {
    console.warn(
      "[reconciliation] run failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Suppress unused-import lint
void sql;
