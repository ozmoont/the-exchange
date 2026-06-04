/**
 * Reliability-based auto-suspend.
 *
 * Runs after every reliability recompute. Walks the partners table, looks at
 * each partner's acceptanceRate over their totalPushed7d sample, and applies
 * status transitions:
 *
 *   active   →  warning      when acceptanceRate < WARN_THRESHOLD with WARN_SAMPLE+ pushes
 *   active   →  suspended    when acceptanceRate < SUSPEND_THRESHOLD with SUSPEND_SAMPLE+ pushes
 *   warning  →  suspended    same suspend rule (escalation)
 *   warning  →  active       NEVER (manual recovery only — admin reviews and unsets)
 *   suspended →  *           NEVER (manual recovery only)
 *
 * Status changes get audit-logged with full before/after metrics. The
 * statusReason column captures a machine-readable explanation so super
 * admins can see why a fleet was suspended without digging into the audit.
 *
 * Operator philosophy: we don't auto-recover. A fleet whose dispatch is bad
 * enough for us to suspend needs a human review before they're back in the
 * routing pool — otherwise we'd flap them up and down on the same data.
 */

import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

const WARN_THRESHOLD = 0.6;
const WARN_SAMPLE = 20;
const SUSPEND_THRESHOLD = 0.4;
const SUSPEND_SAMPLE = 50;

export type AutoSuspendOutcome = {
  scanned: number;
  warned: number;
  suspended: number;
  untouched: number;
};

/**
 * Apply reliability-based status transitions to every active/warning partner.
 * Suspended partners are left alone (they require manual review to come back).
 */
export async function enforceReliabilityThresholds(): Promise<AutoSuspendOutcome> {
  // Only candidates for auto-action are those currently active or warning.
  // Suspended partners stay suspended until a human acts.
  const candidates = await db
    .select()
    .from(partners)
    .where(inArray(partners.status, ["active", "warning"]));

  const outcome: AutoSuspendOutcome = {
    scanned: candidates.length,
    warned: 0,
    suspended: 0,
    untouched: 0,
  };

  for (const p of candidates) {
    const rate = p.acceptanceRate;
    const sample = p.totalPushed7d ?? 0;

    // Need both a meaningful rate AND enough sample
    if (rate === null) {
      outcome.untouched++;
      continue;
    }

    // Suspend check first (more severe)
    if (rate < SUSPEND_THRESHOLD && sample >= SUSPEND_SAMPLE) {
      if (p.status === "suspended") {
        outcome.untouched++;
        continue;
      }
      const reason = `acceptance_rate_${rate.toFixed(2)}_over_${sample}_pushed_7d`;
      await transitionStatus(p, "suspended", reason);
      outcome.suspended++;
      continue;
    }

    // Warning check
    if (rate < WARN_THRESHOLD && sample >= WARN_SAMPLE) {
      if (p.status === "warning") {
        outcome.untouched++;
        continue;
      }
      const reason = `acceptance_rate_${rate.toFixed(2)}_over_${sample}_pushed_7d`;
      await transitionStatus(p, "warning", reason);
      outcome.warned++;
      continue;
    }

    outcome.untouched++;
  }

  return outcome;
}

async function transitionStatus(
  partner: typeof partners.$inferSelect,
  newStatus: "warning" | "suspended",
  reason: string,
): Promise<void> {
  const before = {
    status: partner.status,
    statusReason: partner.statusReason,
    acceptanceRate: partner.acceptanceRate,
    totalPushed7d: partner.totalPushed7d,
  };

  await db
    .update(partners)
    .set({
      status: newStatus,
      statusReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(partners.id, partner.id));

  await db.insert(auditLog).values({
    category: "admin",
    actor: "system",
    actorRef: "auto_suspend_engine",
    action: newStatus === "suspended" ? "partner.auto_suspended" : "partner.auto_warned",
    subjectType: "partner",
    subjectId: partner.id,
    before,
    after: {
      status: newStatus,
      statusReason: reason,
      acceptanceRate: partner.acceptanceRate,
      totalPushed7d: partner.totalPushed7d,
    },
  });
}

export const AUTO_SUSPEND_THRESHOLDS = {
  WARN_THRESHOLD,
  WARN_SAMPLE,
  SUSPEND_THRESHOLD,
  SUSPEND_SAMPLE,
};
