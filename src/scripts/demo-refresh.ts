/**
 * Demo state refresh — make the dashboard tell a complete story.
 *
 * Demo-readiness checklist this script satisfies:
 *
 *   ✓ 80+ active UK partners with geographic spread (calls spawn-fleets if low)
 *   ✓ 200+ transits across the last 14 days so the sparkline has shape
 *   ✓ Backfilled reliability so the "Acceptance" column has real values
 *   ✓ 2–3 auto-suspended fleets so the dashboard banner shows
 *   ✓ 1–2 reconciliation-drift flags so the drift banner shows
 *   ✓ 1–2 pending partner signups so the signups banner shows
 *   ✓ Some completed bookings so the "Completed" stat is non-zero
 *   ✓ At least one synthetic test run in the last hour
 *
 * Every step is idempotent: re-running doesn't pile up junk. If state is
 * already there, the step skips. Safe to run before every demo.
 *
 * Usage:
 *   pnpm demo:refresh
 *
 * Requires: DATABASE_URL, PARTNER_CREDENTIAL_KEY env vars (use .env.local).
 *
 * Not safe to run against a database with real partner traffic — it makes
 * up histories that didn't happen.
 */

import { execSync } from "node:child_process";
import { db } from "../db/client";
import {
  partners,
  transits,
  transitEvents,
  syntheticTestRuns,
  auditLog,
} from "../db/schema";
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// State inspection
// ---------------------------------------------------------------------------

async function inspect() {
  const [active] = await db
    .select({ n: count() })
    .from(partners)
    .where(eq(partners.status, "active"));
  const [pending] = await db
    .select({ n: count() })
    .from(partners)
    .where(eq(partners.status, "pending_approval"));
  const [suspended] = await db
    .select({ n: count() })
    .from(partners)
    .where(eq(partners.status, "suspended"));
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const [recentTransits] = await db
    .select({ n: count() })
    .from(transits)
    .where(gte(transits.createdAt, fourteenDaysAgo));
  const [completedTransits] = await db
    .select({ n: count() })
    .from(transits)
    .where(eq(transits.status, "completed"));
  const [driftFlagged] = await db
    .select({ n: count() })
    .from(transits)
    .where(eq(transits.reconciledFlagged, true));
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const [recentSynthetic] = await db
    .select({ n: count() })
    .from(syntheticTestRuns)
    .where(gte(syntheticTestRuns.ranAt, oneHourAgo));

  return {
    activePartners: Number(active?.n ?? 0),
    pendingSignups: Number(pending?.n ?? 0),
    suspendedPartners: Number(suspended?.n ?? 0),
    transits14d: Number(recentTransits?.n ?? 0),
    completedTransits: Number(completedTransits?.n ?? 0),
    driftFlagged: Number(driftFlagged?.n ?? 0),
    syntheticLastHour: Number(recentSynthetic?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * If active partner count is below the target, call spawn-fleets to top up.
 * That script is already idempotent on partner names.
 */
async function ensurePartners(target = 80) {
  const before = await inspect();
  if (before.activePartners >= target) {
    log("partners", `already ${before.activePartners} active — skipping spawn`);
    return;
  }
  log("partners", `${before.activePartners} active < ${target} — spawning`);
  execSync(`tsx --env-file=.env.local src/scripts/spawn-fleets.ts --count ${target}`, {
    stdio: "inherit",
  });
}

/**
 * Fire jobs in waves spread across the last 14 days so the sparkline has
 * shape. Each wave fires with the current time, then we rewind the
 * createdAt on those new transits. Idempotent: we only fire if 14-day
 * volume is below target.
 */
async function ensureHistoricalVolume(target = 200) {
  const before = await inspect();
  if (before.transits14d >= target) {
    log("volume", `already ${before.transits14d} transits in last 14d — skipping`);
    return;
  }
  const deficit = target - before.transits14d;
  log("volume", `${before.transits14d} < ${target} — firing ${deficit} jobs in waves`);

  // Fire in 5 waves to spread across the time window. Each wave: deficit/5 jobs.
  const wavesPerDay = 5;
  const perWave = Math.ceil(deficit / wavesPerDay);

  for (let wave = 0; wave < wavesPerDay; wave++) {
    const daysAgo = Math.floor((14 / wavesPerDay) * wave) + 1; // 1, 4, 7, 10, 13
    log("volume", `wave ${wave + 1}/${wavesPerDay}: ${perWave} jobs → ${daysAgo}d ago`);

    // Snapshot the timestamp *before* firing — we'll rewind only transits
    // created after this point. Previous waves are already rewound to days
    // ago so they fall outside this filter even if we run waves quickly.
    const firedAfter = new Date();

    execSync(`tsx --env-file=.env.local src/scripts/fire-jobs.ts --count ${perWave}`, {
      stdio: "inherit",
    });

    // Each wave gets a symmetric ±4h jitter around its target day so the
    // sparkline looks naturally clustered rather than 5 spikes.
    const targetTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const driftMs = (Math.random() - 0.5) * 8 * 60 * 60 * 1000; // ±4h
    const finalTime = new Date(targetTime.getTime() + driftMs);

    const updated = await db
      .update(transits)
      .set({
        createdAt: finalTime,
        updatedAt: finalTime,
      })
      .where(
        and(
          gte(transits.createdAt, firedAfter),
          sql`${transits.originatorBookingExternalId} LIKE 'TEST-%'`,
        ),
      );
    void updated;
  }
}

/**
 * Call the backfill-reliability script. It creates acceptance/completion
 * events on every pushed transit and triggers auto-suspend enforcement, so
 * it covers both "fill the reliability column" and "create auto-suspended
 * fleets" in one shot.
 */
async function ensureReliability() {
  log("reliability", "running backfill — this also triggers auto-suspend");
  execSync(`tsx --env-file=.env.local src/scripts/backfill-reliability.ts`, {
    stdio: "inherit",
  });
}

/**
 * Force a small number of auto-suspended fleets to exist by directly
 * suspending laggards if backfill didn't push enough across the threshold.
 * Threshold is 40% acceptance over 50+ pushed bookings; if our sample isn't
 * big enough we manually flip 2 fleets so the banner has something to show.
 */
async function ensureAutoSuspended(target = 2) {
  const before = await inspect();
  if (before.suspendedPartners >= target) {
    log("auto-suspend", `already ${before.suspendedPartners} suspended — skipping`);
    return;
  }
  const need = target - before.suspendedPartners;
  log("auto-suspend", `need ${need} more suspended fleets`);

  // Pick partners with the lowest acceptance rates that are currently active.
  const candidates = await db
    .select()
    .from(partners)
    .where(
      and(
        eq(partners.status, "active"),
        isNotNull(partners.acceptanceRate),
      ),
    )
    .orderBy(partners.acceptanceRate);

  const toSuspend = candidates.slice(0, need);
  for (const p of toSuspend) {
    const ratePct = ((p.acceptanceRate ?? 0) * 100).toFixed(0);
    const reason = `acceptance_rate_0.${ratePct.padStart(2, "0")}_over_${p.totalPushed7d ?? 0}_pushed_7d_demo_seed`;
    await db
      .update(partners)
      .set({
        status: "suspended",
        statusReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, p.id));
    await db.insert(auditLog).values({
      category: "admin",
      actor: "system",
      actorRef: "demo_refresh",
      action: "partner.auto_suspended",
      subjectType: "partner",
      subjectId: p.id,
      before: { status: "active" },
      after: { status: "suspended", reason },
    });
    log("auto-suspend", `suspended ${p.name} (acceptance ${ratePct}%)`);
  }
}

/**
 * Mark 1-2 completed transits with reconciliation drift so the dashboard
 * banner has something to show. We synthesise originator/recipient billed
 * totals that disagree by ~£8 to land just over the 5% / 50p threshold.
 */
async function ensureDriftFlags(target = 1) {
  const before = await inspect();
  if (before.driftFlagged >= target) {
    log("drift", `already ${before.driftFlagged} flagged — skipping`);
    return;
  }
  const need = target - before.driftFlagged;
  // Pick completed transits that haven't been reconciled yet.
  const candidates = await db
    .select()
    .from(transits)
    .where(
      and(
        eq(transits.status, "completed"),
        isNull(transits.reconciledAt),
        isNotNull(transits.recipientPartnerId),
      ),
    )
    .limit(need * 3);

  if (candidates.length === 0) {
    log("drift", "no eligible completed transits — skipping");
    return;
  }
  for (const t of candidates.slice(0, need)) {
    // Synthesise totals: originator says £42, recipient billed £50.20 → £8.20 drift.
    const originatorTotal = 4200;
    const recipientTotal = 5020;
    const drift = Math.abs(originatorTotal - recipientTotal);
    await db
      .update(transits)
      .set({
        reconciledAt: new Date(),
        reconciledOriginatorTotalPence: originatorTotal,
        reconciledRecipientTotalPence: recipientTotal,
        reconciledDriftPence: drift,
        reconciledFlagged: true,
        updatedAt: new Date(),
      })
      .where(eq(transits.id, t.id));
    await db.insert(auditLog).values({
      category: "fee",
      actor: "system",
      actorRef: "demo_refresh",
      action: "transit.reconciliation_flagged",
      subjectType: "transit",
      subjectId: t.id,
      before: null,
      after: {
        originatorTotalPence: originatorTotal,
        recipientTotalPence: recipientTotal,
        driftPence: drift,
        note: "synthesised by demo:refresh for banner demonstration",
      },
    });
    log("drift", `flagged transit ${t.id.slice(0, 8)} — £${(drift / 100).toFixed(2)} drift`);
  }
}

/**
 * Create 1-2 pending signups so the signups review banner shows on the
 * dashboard. Uses synthetic-looking partner names + emails.
 */
async function ensurePendingSignups(target = 2) {
  const before = await inspect();
  if (before.pendingSignups >= target) {
    log("signups", `already ${before.pendingSignups} pending — skipping`);
    return;
  }
  const need = target - before.pendingSignups;
  const samples = [
    {
      name: "Demo Cabs Glasgow",
      legal: "Demo Cabs Glasgow Ltd",
      email: "ops@demo-cabs-glasgow.example",
      notes:
        "Mid-size fleet, 60 vehicles, looking to add demand-side coverage to airport and corporate runs.",
    },
    {
      name: "Demo Express Manchester",
      legal: "Demo Express Manchester Ltd",
      email: "newbiz@demo-express.example",
      notes:
        "WAV-specialist fleet, regulated routes. Interested in being a supply partner for cross-network jobs.",
    },
  ];
  for (let i = 0; i < need && i < samples.length; i++) {
    const s = samples[i];
    // Check we don't already have a partner with this applicant email
    const [existing] = await db
      .select()
      .from(partners)
      .where(eq(partners.applicantEmail, s.email));
    if (existing) {
      log("signups", `${s.email} already applied — skipping`);
      continue;
    }
    await db.insert(partners).values({
      kind: "icabbi_fleet",
      name: s.name,
      legalName: s.legal,
      adapterKey: "icabbi",
      status: "pending_approval",
      applicantEmail: s.email,
      applicationNotes: s.notes,
      participationMode: "inactive",
      operatingRegions: ["UK"],
      bookingTypes: ["asap", "prebook"],
    });
    log("signups", `created pending signup: ${s.name}`);
  }
}

/**
 * Drop a synthetic test run from "5 minutes ago" so the status page has a
 * fresh data point even if the hourly cron hasn't fired since the last
 * refresh.
 */
async function ensureSyntheticTrace() {
  const before = await inspect();
  if (before.syntheticLastHour > 0) {
    log("synthetic", `${before.syntheticLastHour} run(s) in last hour — skipping`);
    return;
  }
  await db.insert(syntheticTestRuns).values({
    ranAt: new Date(Date.now() - 5 * 60_000),
    outcome: "pushed",
    elapsedMs: 1340,
  });
  log("synthetic", "inserted a fresh 'pushed' synthetic run (5 min ago)");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(section: string, msg: string) {
  // Aligned, easy to scan during a live demo prep.
  console.log(`[demo:refresh] [${section.padEnd(12)}] ${msg}`);
}

function printSummary(label: string, s: Awaited<ReturnType<typeof inspect>>) {
  console.log(`\n[demo:refresh] ${label}:`);
  console.log(`  Active partners        : ${s.activePartners}`);
  console.log(`  Pending signups        : ${s.pendingSignups}`);
  console.log(`  Suspended partners     : ${s.suspendedPartners}`);
  console.log(`  Transits (14d)         : ${s.transits14d}`);
  console.log(`  Completed transits     : ${s.completedTransits}`);
  console.log(`  Reconciliation flagged : ${s.driftFlagged}`);
  console.log(`  Synthetic (last hour)  : ${s.syntheticLastHour}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const start = Date.now();
  console.log("[demo:refresh] starting — this is idempotent, safe to re-run\n");
  const before = await inspect();
  printSummary("BEFORE", before);

  await ensurePartners(80);
  await ensureHistoricalVolume(200);
  await ensureReliability();
  await ensureAutoSuspended(2);
  await ensureDriftFlags(1);
  await ensurePendingSignups(2);
  await ensureSyntheticTrace();

  const after = await inspect();
  printSummary("AFTER", after);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[demo:refresh] done in ${elapsed}s — demo state should be complete.`);
  console.log(`[demo:refresh] Visit /status to confirm everything is green.`);
  console.log(`[demo:refresh] Visit / to confirm banners are showing.`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[demo:refresh] FAILED", err);
  process.exit(1);
});
