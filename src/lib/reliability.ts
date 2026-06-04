/**
 * Per-partner reliability scoring.
 *
 * We compute four metrics over a rolling 7-day window for every active
 * partner that has received bookings:
 *
 *   - acceptanceRate: bookings_advanced_past_pushed / bookings_pushed
 *   - completionRate: bookings_completed / bookings_accepted
 *   - autoRerouteRate: bookings_we_rerouted_away / bookings_pushed
 *   - medianAcceptanceMs: time from 'pushed' to first onward state (p50)
 *
 * The routing engine reads `acceptanceRate` and adds a penalty to the
 * candidate score — see RELIABILITY_PENALTY_WEIGHT in routing.ts. A fleet
 * with 90% acceptance gets a small penalty; 50% acceptance gets a large
 * penalty; new fleets (null metrics) are neutral.
 *
 * Sample-size guard: when totalPushed7d < 5 we treat metrics as not yet
 * meaningful and routing falls back to fee+distance only. Avoids punishing
 * a brand-new fleet on their first low-volume week.
 *
 * Runs every 5 minutes in demo mode (via maybeTickDemoMode). In production
 * this becomes a Vercel cron when async routing lands.
 */

import { db } from "@/db/client";
import { partners, transits, transitEvents, networkControls } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { captureError } from "@/lib/observability";

const WINDOW_DAYS = 7;
const COMPUTE_COOLDOWN_MS = 5 * 60_000;
const MIN_SAMPLE_FOR_PENALTY = 5;

export type PartnerReliability = {
  partnerId: string;
  acceptanceRate: number | null;
  completionRate: number | null;
  autoRerouteRate: number | null;
  medianAcceptanceMs: number | null;
  totalPushed7d: number;
};

/**
 * Compute and persist reliability for every active partner. Returns the
 * number of partners updated.
 */
export async function recomputeAllPartnerReliability(): Promise<number> {
  // Per-partner aggregates over the window. We compute everything in a single
  // round-trip via GROUP BY — 100 active partners returns 100 rows in <50ms
  // on Neon. Window is expressed inline via Postgres `now() - interval` so we
  // don't have to pass a JS Date as a parameter (postgres.js's drizzle wrapper
  // doesn't bind Date objects cleanly).
  const rows = await db.execute<{
    partnerId: string;
    totalPushed: number;
    totalAccepted: number;
    totalCompleted: number;
    totalRerouted: number;
    medianAcceptanceMs: number | null;
  }>(sql.raw(`
    WITH pushed AS (
      SELECT
        t.recipient_partner_id AS partner_id,
        t.id                   AS transit_id,
        t.status               AS final_status,
        t.reroute_count        AS reroute_count,
        -- earliest 'pushed' event for this transit
        (
          SELECT MIN(e.created_at)
          FROM transit_events e
          WHERE e.transit_id = t.id AND e.status = 'pushed'
        ) AS pushed_at,
        -- earliest onward (accepted+) event for this transit
        (
          SELECT MIN(e.created_at)
          FROM transit_events e
          WHERE e.transit_id = t.id
            AND e.status IN ('accepted', 'driver_assigned', 'driver_arrived', 'en_route', 'on_board', 'completed')
        ) AS accepted_at
      FROM transits t
      WHERE t.recipient_partner_id IS NOT NULL
        AND t.created_at > now() - interval '${WINDOW_DAYS} days'
    )
    SELECT
      partner_id                                                     AS "partnerId",
      COUNT(*)::int                                                  AS "totalPushed",
      COUNT(*) FILTER (WHERE accepted_at IS NOT NULL)::int           AS "totalAccepted",
      COUNT(*) FILTER (WHERE final_status = 'completed')::int        AS "totalCompleted",
      COUNT(*) FILTER (WHERE reroute_count > 0)::int                 AS "totalRerouted",
      ROUND(
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (accepted_at - pushed_at)) * 1000
        )
      )::int                                                         AS "medianAcceptanceMs"
    FROM pushed
    GROUP BY partner_id
  `));

  // drizzle returns the rows directly (no `.rows` wrapper) for postgres.js
  const aggregated = (rows as unknown as Array<{
    partnerId: string;
    totalPushed: number;
    totalAccepted: number;
    totalCompleted: number;
    totalRerouted: number;
    medianAcceptanceMs: number | null;
  }>);

  // Some drivers DO use { rows: [...] } — handle both
  const list = Array.isArray(aggregated)
    ? aggregated
    : (aggregated as unknown as { rows: typeof aggregated })?.rows ?? [];

  let updated = 0;
  for (const row of list) {
    const acceptanceRate = row.totalPushed > 0 ? row.totalAccepted / row.totalPushed : null;
    const completionRate =
      row.totalAccepted > 0 ? row.totalCompleted / row.totalAccepted : null;
    const autoRerouteRate = row.totalPushed > 0 ? row.totalRerouted / row.totalPushed : null;

    await db
      .update(partners)
      .set({
        acceptanceRate,
        completionRate,
        autoRerouteRate,
        medianAcceptanceMs: row.medianAcceptanceMs,
        totalPushed7d: row.totalPushed,
        metricsUpdatedAt: new Date(),
      })
      .where(eq(partners.id, row.partnerId));
    updated++;
  }

  // Reset metrics for any partner who DIDN'T receive any bookings in the window
  // (else stale metrics persist forever). We do this with a single update.
  const receivingPartnerIds = list.map((r) => r.partnerId);
  if (receivingPartnerIds.length > 0) {
    await db.execute(sql`
      UPDATE partners
      SET acceptance_rate = NULL,
          completion_rate = NULL,
          auto_reroute_rate = NULL,
          median_acceptance_ms = NULL,
          total_pushed_7d = 0,
          metrics_updated_at = NOW()
      WHERE id NOT IN ${sql.raw(`('${receivingPartnerIds.join("','")}')`)}
        AND total_pushed_7d > 0
    `);
  }

  return updated;
}

/**
 * Tick wrapper with cooldown. Safe to call on every page render — only does
 * work when the cooldown has elapsed.
 */
export async function maybeRecomputeReliability(): Promise<void> {
  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  const now = new Date();
  const lastRun = control?.lastReliabilityComputeAt;
  if (lastRun && now.getTime() - lastRun.getTime() < COMPUTE_COOLDOWN_MS) return;

  // Claim the tick first so concurrent renders don't all run the query.
  await db
    .update(networkControls)
    .set({ lastReliabilityComputeAt: now })
    .where(eq(networkControls.id, "global"));

  try {
    const updated = await recomputeAllPartnerReliability();
    if (updated > 0) {
      console.log(`[reliability] recomputed metrics for ${updated} partner(s)`);
    }
    // After fresh metrics land, enforce thresholds. Dynamic import keeps the
    // auto-suspend logic decoupled (and easy to disable for replays/imports).
    const { enforceReliabilityThresholds } = await import("@/lib/auto-suspend");
    const outcome = await enforceReliabilityThresholds();
    if (outcome.warned > 0 || outcome.suspended > 0) {
      console.log(
        `[auto-suspend] scanned=${outcome.scanned} warned=${outcome.warned} suspended=${outcome.suspended}`,
      );
    }
  } catch (err) {
    captureError(err, { area: "reliability_recompute" });
  }
}

/**
 * Convert acceptance rate + sample size to a scoring penalty.
 *
 * Returns 0 when the sample is too small (no data → neutral) or when
 * acceptance is high. Returns up to RELIABILITY_PENALTY_MAX when acceptance
 * is low. Caller decides the weight by importing the function and adding to
 * their score.
 */
export const RELIABILITY_PENALTY_MAX = 200; // ~ equivalent to 40km extra distance

export function reliabilityPenalty(
  acceptanceRate: number | null,
  totalPushed7d: number | null,
): number {
  if (acceptanceRate === null || totalPushed7d === null) return 0;
  if (totalPushed7d < MIN_SAMPLE_FOR_PENALTY) return 0;
  // Linear: 100% acceptance = 0 penalty, 0% acceptance = MAX penalty
  return RELIABILITY_PENALTY_MAX * (1 - acceptanceRate);
}

// Suppress unused-import linter when `and` and `gte` aren't both used below
// (they were drafts of an earlier version; keep imports because they're cheap
// and we may re-use them when we extend this module).
void and;
void gte;
