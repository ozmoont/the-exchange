/**
 * One-shot reliability backfill.
 *
 * Problem: the existing demo data (the 500-job fire-jobs run from earlier
 * sessions) was created before the acceptance-window + reliability logic
 * shipped. Those transits sit at status='pushed' indefinitely with no
 * accepted/completed events on them, so the SQL that computes
 * acceptanceRate / completionRate / medianAcceptanceMs has nothing to chew
 * on. Result: partner detail Reliability sections stay empty, auto-suspend
 * never fires, distribution Accept rate column shows '—' for everyone.
 *
 * This script synthesises a realistic acceptance + completion history on
 * those transits so we can demo the full closed-loop without firing fresh
 * traffic. Behaviour:
 *
 *   1. For every partner, assign a deterministic target acceptance rate
 *      (seeded from their id so re-runs are stable). Most partners get a
 *      90-98% rate; a long-tail minority get 40-80% so auto-suspend has
 *      something to chew on.
 *   2. For every transit at status='pushed' (recipient assigned but no
 *      accepted+ event), roll against the recipient's target rate. If
 *      accepted, write an 'accepted' transit_event at push + jittered
 *      5-90s and advance the transit. Then progress ~80% of accepted ones
 *      further to driver_assigned → completed.
 *   3. After all transits are processed, force a fresh reliability
 *      recompute + auto-suspend enforcement.
 *
 * Idempotent: skips transits that already have an 'accepted' event.
 * Safe to run repeatedly. Won't touch transits already in terminal state.
 *
 * Usage:
 *   pnpm backfill-reliability                            # default
 *   pnpm backfill-reliability --partner-rate-min 0.40    # tweak distribution
 *   pnpm backfill-reliability --partner-rate-max 0.98
 *   pnpm backfill-reliability --laggard-fraction 0.10    # 10% problem fleets
 *
 * Only safe to run against demo data. Don't point this at a database with
 * real partner traffic — it makes up acceptances that didn't happen.
 */

import { db } from "../db/client";
import { partners, transits, transitEvents } from "../db/schema";
import { eq, and, inArray, isNotNull, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";

type Args = {
  partnerRateMin: number;
  partnerRateMax: number;
  laggardFraction: number;
  laggardMinRate: number;
  laggardMaxRate: number;
  completedShare: number;
  concurrency: number;
  limit: number; // 0 = no cap
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    partnerRateMin: 0.85,
    partnerRateMax: 0.98,
    laggardFraction: 0.1,
    laggardMinRate: 0.3,
    laggardMaxRate: 0.7,
    completedShare: 0.8,
    concurrency: 8,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = Number(argv[i + 1]);
    if (k === "--partner-rate-min" && Number.isFinite(v)) { a.partnerRateMin = v; i++; }
    else if (k === "--partner-rate-max" && Number.isFinite(v)) { a.partnerRateMax = v; i++; }
    else if (k === "--laggard-fraction" && Number.isFinite(v)) { a.laggardFraction = v; i++; }
    else if (k === "--laggard-min-rate" && Number.isFinite(v)) { a.laggardMinRate = v; i++; }
    else if (k === "--laggard-max-rate" && Number.isFinite(v)) { a.laggardMaxRate = v; i++; }
    else if (k === "--completed-share" && Number.isFinite(v)) { a.completedShare = v; i++; }
    else if (k === "--concurrency" && Number.isFinite(v)) { a.concurrency = v; i++; }
    else if (k === "--limit" && Number.isFinite(v)) { a.limit = v; i++; }
  }
  return a;
}

function partnerSeed(partnerId: string): number {
  // Deterministic [0, 1) from partner id — re-running the script doesn't
  // re-roll target rates so the network behaviour is stable across runs.
  const h = createHash("sha256").update(partnerId).digest();
  return (h.readUInt32BE(0) % 1_000_000) / 1_000_000;
}

function pickTargetRate(partnerId: string, args: Args): number {
  const seed = partnerSeed(partnerId);
  // Use the first part of the seed to decide if this partner is a laggard
  if (seed < args.laggardFraction) {
    // Laggard — distribute uniformly in [laggardMinRate, laggardMaxRate)
    // re-seeded to avoid correlation with the laggard test itself
    const sub = (seed / args.laggardFraction);
    return args.laggardMinRate + sub * (args.laggardMaxRate - args.laggardMinRate);
  }
  const sub = (seed - args.laggardFraction) / (1 - args.laggardFraction);
  return args.partnerRateMin + sub * (args.partnerRateMax - args.partnerRateMin);
}

async function main() {
  const args = parseArgs();
  console.log("Reliability backfill — settings:");
  console.log(`  Normal partners: ${args.partnerRateMin}–${args.partnerRateMax} acceptance`);
  console.log(`  Laggard partners (${(args.laggardFraction * 100).toFixed(0)}%): ${args.laggardMinRate}–${args.laggardMaxRate}`);
  console.log(`  ${(args.completedShare * 100).toFixed(0)}% of accepted bookings advance to completed`);
  console.log();

  // 1. Compute per-partner target rates
  const partnerRows = await db.select().from(partners);
  const targetRateByPartner = new Map<string, number>();
  for (const p of partnerRows) {
    targetRateByPartner.set(p.id, pickTargetRate(p.id, args));
  }

  // Show the laggards so the operator can spot what auto-suspend will hit
  const laggards = [...targetRateByPartner.entries()]
    .filter(([, rate]) => rate < 0.7)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 10);
  if (laggards.length > 0) {
    console.log("Partners destined for warning/suspend (top 10 worst rates):");
    for (const [id, rate] of laggards) {
      const p = partnerRows.find((r) => r.id === id);
      console.log(`  ${p?.name ?? id.slice(0, 8)}: ${(rate * 100).toFixed(0)}% target`);
    }
    console.log();
  }

  // 2. Find pushed transits that haven't been advanced yet — recipient
  // assigned, no 'accepted' event present.
  const pushedTransits = await db
    .select()
    .from(transits)
    .where(and(eq(transits.status, "pushed"), isNotNull(transits.recipientPartnerId)));

  if (pushedTransits.length === 0) {
    console.log("No pushed transits to backfill. Done.");
    return;
  }

  console.log(`Found ${pushedTransits.length} pushed transits with recipient assigned.`);

  // Filter out any that already have an 'accepted' event (idempotency)
  const transitIds = pushedTransits.map((t) => t.id);
  const acceptedEvents = await db
    .select({ transitId: transitEvents.transitId })
    .from(transitEvents)
    .where(
      and(
        inArray(transitEvents.transitId, transitIds),
        eq(transitEvents.status, "accepted"),
      ),
    );
  const alreadyAccepted = new Set(acceptedEvents.map((e) => e.transitId));
  let toProcess = pushedTransits.filter((t) => !alreadyAccepted.has(t.id));
  if (args.limit > 0 && args.limit < toProcess.length) {
    console.log(`  Limit applied: processing first ${args.limit} of ${toProcess.length}.`);
    toProcess = toProcess.slice(0, args.limit);
  }
  console.log(`  ${toProcess.length} need synthesis · ${alreadyAccepted.size} already advanced. (concurrency=${args.concurrency})`);
  console.log();

  // 3. Walk each transit, decide outcome, write events + status updates
  const counts = {
    acceptedAndCompleted: 0,
    acceptedNotCompleted: 0,
    ghosted: 0, // recipient "didn't accept" — we leave as pushed for the
                // recheckStaleAcceptances tick to reroute naturally
    error: 0,
  };

  let processedSoFar = 0;
  const startTime = Date.now();
  let nextIdx = 0;
  async function processOne(t: typeof toProcess[number]) {
    processedSoFar++;
    if (processedSoFar % 25 === 0 || processedSoFar === toProcess.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processedSoFar / Math.max(0.1, Number(elapsed))).toFixed(1);
      process.stdout.write(
        `  ${processedSoFar}/${toProcess.length} (${rate}/s, ${elapsed}s elapsed)\r`,
      );
    }
    if (!t.recipientPartnerId) return;
    try {
      const rate = targetRateByPartner.get(t.recipientPartnerId);
      if (rate === undefined) {
        counts.ghosted++;
        return;
      }

      // Use a per-transit random seed so the same transit gets the same
      // decision if backfill is run again (idempotency safety net).
      const transitSeed = partnerSeed(t.id);
      const wouldAccept = transitSeed < rate;

      if (!wouldAccept) {
        counts.ghosted++;
        return;
      }

      const createdAt = new Date(t.createdAt);
      // jittered 5–90s acceptance latency
      const acceptDelayMs = 5_000 + Math.floor(transitSeed * 85_000);
      const acceptedAt = new Date(createdAt.getTime() + acceptDelayMs);

      // Write the 'accepted' event
      await db.insert(transitEvents).values({
        transitId: t.id,
        status: "accepted",
        detail: { source: "backfill", latencyMs: acceptDelayMs },
        actor: "system",
        createdAt: acceptedAt,
      });

      // Decide whether to advance further to completed
      const advanceToCompleted = partnerSeed(t.id + "complete") < args.completedShare;

      if (!advanceToCompleted) {
        // Leave at 'accepted' status — counts toward acceptance rate but not
        // completion rate. Realistic mix.
        await db
          .update(transits)
          .set({
            status: "accepted",
            acceptDeadline: null, // satisfied
            updatedAt: acceptedAt,
          })
          .where(eq(transits.id, t.id));
        counts.acceptedNotCompleted++;
        return;
      }

      // Add lifecycle events through to completed at realistic intervals
      const tripStart = new Date(acceptedAt.getTime() + 60_000);  // 1 min to driver assign
      const enRoute = new Date(tripStart.getTime() + 30_000);     // 30s
      const onBoard = new Date(enRoute.getTime() + 4 * 60_000);   // 4 min driver to pickup
      const completed = new Date(onBoard.getTime() + 12 * 60_000); // 12 min trip

      await db.insert(transitEvents).values([
        {
          transitId: t.id,
          status: "driver_assigned",
          detail: { source: "backfill" },
          actor: "system",
          createdAt: tripStart,
        },
        {
          transitId: t.id,
          status: "en_route",
          detail: { source: "backfill" },
          actor: "system",
          createdAt: enRoute,
        },
        {
          transitId: t.id,
          status: "on_board",
          detail: { source: "backfill" },
          actor: "system",
          createdAt: onBoard,
        },
        {
          transitId: t.id,
          status: "completed",
          detail: { source: "backfill" },
          actor: "system",
          createdAt: completed,
        },
      ]);
      await db
        .update(transits)
        .set({ status: "completed", acceptDeadline: null, updatedAt: completed })
        .where(eq(transits.id, t.id));
      counts.acceptedAndCompleted++;
    } catch (err) {
      counts.error++;
      console.error(`  transit ${t.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Worker pool — N parallel processOne()s pulling from the shared toProcess array
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= toProcess.length) return;
      await processOne(toProcess[idx]);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < args.concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  console.log(); // newline after the carriage-return progress bar

  console.log("Backfill outcomes:");
  console.log(`  Accepted + completed:   ${counts.acceptedAndCompleted}`);
  console.log(`  Accepted, mid-flight:   ${counts.acceptedNotCompleted}`);
  console.log(`  Ghosted (still pushed): ${counts.ghosted}`);
  console.log(`  Errors:                 ${counts.error}`);
  console.log();

  // 4. Force a reliability recompute + auto-suspend enforcement so the
  // dashboard picks up the new data immediately.
  console.log("Recomputing reliability metrics + applying thresholds...");
  // Use dynamic require to share the in-process db connection
  const { recomputeAllPartnerReliability } = await import("../lib/reliability");
  const updated = await recomputeAllPartnerReliability();
  console.log(`  Reliability metrics written for ${updated} partner(s).`);

  const { enforceReliabilityThresholds } = await import("../lib/auto-suspend");
  const enforcement = await enforceReliabilityThresholds();
  console.log(
    `  Auto-suspend: scanned=${enforcement.scanned} warned=${enforcement.warned} ` +
      `suspended=${enforcement.suspended} untouched=${enforcement.untouched}`,
  );

  // Also need to reset the network controls cooldown so the demo tick's
  // maybeRecomputeReliability runs again immediately. Otherwise next 5 minutes
  // will re-clobber what we just wrote with the same data, which is fine,
  // but feels weird if the operator runs this then watches the dashboard.
  console.log("\nDone. Refresh /distribution or any partner detail page to see updated metrics.");

  // Suppress unused-import lint
  void isNull;
}

main().catch((err) => {
  console.error("[backfill-reliability] fatal:", err);
  process.exit(1);
});
