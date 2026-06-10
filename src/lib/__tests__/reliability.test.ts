import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

/**
 * Reliability scoring tests (src/lib/reliability.ts). Three layers:
 *   1. reliabilityPenalty — pure scoring fn (sample guard + linear curve).
 *   2. recomputeAllPartnerReliability — aggregate SQL rows → per-partner
 *      metric updates + stale-metrics reset; verifies JS math + writes.
 *   3. maybeRecomputeReliability — cooldown-gated tick: claim, recompute, enforce.
 * No real DB: db.execute results queued per test, updates recorded.
 * auto-suspend mocked (own suite in auto-suspend.test.ts).
 */

const dbController = {
  /** Rows for the single networkControls select in maybeRecompute. */
  networkControls: [] as unknown[],
  /** FIFO queue of db.execute results. "THROW" rejects that call. */
  executeResults: [] as unknown[],
  executeCalls: 0,
  /** Every update().set() recorded with its table name. */
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
};

// Only partners + networkControls are touched; identify by reference.
const TABLE_NAMES = new Map<unknown, string>([
  [schema.partners, "partners"],
  [schema.networkControls, "networkControls"],
]);

vi.mock("@/db/client", () => ({
  db: {
    // Only one select (networkControls in the tick wrapper).
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dbController.networkControls),
      }),
    }),
    update: (tbl: unknown) => ({
      set: (v: Record<string, unknown>) => {
        dbController.updates.push({ table: TABLE_NAMES.get(tbl) ?? "unknown", set: v });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    execute: () => {
      dbController.executeCalls++;
      const next = dbController.executeResults.shift();
      if (next === "THROW") return Promise.reject(new Error("execute failed (test-configured)"));
      return Promise.resolve(next ?? []);
    },
  },
}));

// Stub so tick tests can assert it runs AFTER fresh metrics land.
const autoSuspendController = {
  outcome: { scanned: 0, warned: 0, suspended: 0, untouched: 0 },
  calls: 0,
};
vi.mock("@/lib/auto-suspend", () => ({
  enforceReliabilityThresholds: async () => {
    autoSuspendController.calls++;
    return autoSuspendController.outcome;
  },
}));

// Spy — the tick must swallow recompute failures, not throw.
vi.mock("@/lib/observability", () => ({ captureError: vi.fn() }));

import { captureError } from "@/lib/observability";
import {
  RELIABILITY_PENALTY_MAX,
  maybeRecomputeReliability,
  recomputeAllPartnerReliability,
  reliabilityPenalty,
} from "@/lib/reliability";

// Clock pinned to a fixed June-2026 instant for cooldown math.
const NOW = new Date("2026-06-10T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbController.networkControls = [];
  dbController.executeResults = [];
  dbController.executeCalls = 0;
  dbController.updates = [];
  autoSuspendController.outcome = { scanned: 0, warned: 0, suspended: 0, untouched: 0 };
  autoSuspendController.calls = 0;
  vi.mocked(captureError).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function partnerUpdates() {
  return dbController.updates.filter((u) => u.table === "partners").map((u) => u.set);
}

describe("reliabilityPenalty", () => {
  it("is neutral (0) for partners with no metrics yet", () => {
    // Null metrics (new fleets) must not be penalised.
    expect(reliabilityPenalty(null, null)).toBe(0);
    expect(reliabilityPenalty(0.1, null)).toBe(0);
    expect(reliabilityPenalty(null, 100)).toBe(0);
  });

  it("is neutral below the 5-push sample-size guard", () => {
    // MIN_SAMPLE_FOR_PENALTY guard keeps tiny samples (4 pushes) out of scoring.
    expect(reliabilityPenalty(0.0, 4)).toBe(0);
  });

  it("activates exactly at the 5-push boundary", () => {
    // Boundary: sample of exactly 5 IS enough (>=).
    expect(reliabilityPenalty(0.5, 5)).toBe(100);
  });

  it("is 0 at 100% acceptance and MAX (200) at 0% acceptance", () => {
    // Curve endpoints: 100% pays nothing, 0% pays the documented max.
    expect(reliabilityPenalty(1, 50)).toBe(0);
    expect(reliabilityPenalty(0, 50)).toBe(RELIABILITY_PENALTY_MAX);
  });

  it("scales linearly between the endpoints", () => {
    // 75% → 25% of MAX = 50. Locks the linear interpolation.
    expect(reliabilityPenalty(0.75, 50)).toBe(50);
    expect(reliabilityPenalty(0.9, 50)).toBeCloseTo(20, 10);
  });
});

describe("recomputeAllPartnerReliability", () => {
  // Aggregate row shaped like the GROUP BY query output.
  const aggRow = {
    partnerId: "p-1",
    totalPushed: 10,
    totalAccepted: 8,
    totalCompleted: 6,
    totalRerouted: 1,
    medianAcceptanceMs: 1234,
  };

  it("writes derived rates onto each partner and runs the stale-metrics reset", async () => {
    // JS math: acceptance 8/10, completion 6/8, reroute 1/10. 2nd execute = NOT-IN reset.
    // FLAG (not under test): that reset string-joins ids into sql.raw at reliability.ts:147
    // instead of parameterizing. Ids are our own UUIDs (low risk) but a quote would break it.
    dbController.executeResults = [[aggRow], []];

    const updated = await recomputeAllPartnerReliability();

    expect(updated).toBe(1);
    expect(partnerUpdates()[0]).toMatchObject({
      acceptanceRate: 0.8,
      completionRate: 0.75,
      autoRerouteRate: 0.1,
      medianAcceptanceMs: 1234,
      totalPushed7d: 10,
    });
    expect(partnerUpdates()[0].metricsUpdatedAt).toBeInstanceOf(Date);
    expect(dbController.executeCalls).toBe(2); // aggregate query + reset query
  });

  it("returns one update per aggregate row", async () => {
    // Each aggregate row → its own partners UPDATE.
    dbController.executeResults = [[aggRow, { ...aggRow, partnerId: "p-2", totalPushed: 4, totalAccepted: 1 }], []];

    const updated = await recomputeAllPartnerReliability();
    expect(updated).toBe(2);
    expect(partnerUpdates()).toHaveLength(2);
    expect(partnerUpdates()[1]).toMatchObject({ acceptanceRate: 0.25, totalPushed7d: 4 });
  });

  it("writes null rates when a row has zero denominators", async () => {
    // FLAG (defensive): GROUP BY can't emit totalPushed=0, but the JS guards exist —
    // zero denominators must yield null, never NaN/Infinity.
    dbController.executeResults = [
      [{ partnerId: "p-z", totalPushed: 0, totalAccepted: 0, totalCompleted: 0, totalRerouted: 0, medianAcceptanceMs: null }],
      [],
    ];

    await recomputeAllPartnerReliability();
    expect(partnerUpdates()[0]).toMatchObject({
      acceptanceRate: null,
      completionRate: null,
      autoRerouteRate: null,
    });
  });

  it("does nothing (and skips the reset) when no partner received bookings", async () => {
    // Empty window: zero updates AND no reset (empty NOT IN would be malformed SQL).
    dbController.executeResults = [[]];

    const updated = await recomputeAllPartnerReliability();
    expect(updated).toBe(0);
    expect(partnerUpdates()).toHaveLength(0);
    expect(dbController.executeCalls).toBe(1); // aggregate query only
  });

  it("handles drivers that wrap results in { rows: [...] }", async () => {
    // Supports both postgres.js (bare array) and drivers returning { rows }.
    dbController.executeResults = [{ rows: [aggRow] }, []];

    const updated = await recomputeAllPartnerReliability();
    expect(updated).toBe(1);
    expect(partnerUpdates()[0]).toMatchObject({ acceptanceRate: 0.8 });
  });
});

describe("maybeRecomputeReliability", () => {
  it("runs on first tick (no prior run recorded): claims, recomputes, enforces", async () => {
    // No control row → full tick; claim must land BEFORE recompute to avoid double-run.
    dbController.networkControls = [];
    dbController.executeResults = [[]];

    await maybeRecomputeReliability();

    const claim = dbController.updates.find((u) => u.table === "networkControls");
    expect(claim?.set.lastReliabilityComputeAt).toBeInstanceOf(Date);
    expect(dbController.executeCalls).toBe(1); // recompute ran
    expect(autoSuspendController.calls).toBe(1); // thresholds enforced after metrics
  });

  it("returns early inside the 5-minute cooldown without touching anything", async () => {
    // Renders within the cooldown must be free — no claim, recompute, or auto-suspend.
    dbController.networkControls = [
      { id: "global", lastReliabilityComputeAt: new Date(NOW - 60_000) }, // 1 min ago
    ];

    await maybeRecomputeReliability();

    expect(dbController.updates).toHaveLength(0);
    expect(dbController.executeCalls).toBe(0);
    expect(autoSuspendController.calls).toBe(0);
  });

  it("runs again once the cooldown has elapsed", async () => {
    // 10min since last run (> 5-min cooldown) → tick proceeds.
    dbController.networkControls = [
      { id: "global", lastReliabilityComputeAt: new Date(NOW - 10 * 60_000) },
    ];
    dbController.executeResults = [[]];

    await maybeRecomputeReliability();

    expect(dbController.executeCalls).toBe(1);
    expect(autoSuspendController.calls).toBe(1);
  });

  it("logs summaries when partners were updated and auto-suspend acted", async () => {
    // A tick that changed things logs two lines: recompute + auto-suspend.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbController.networkControls = [];
    dbController.executeResults = [
      [{ partnerId: "p-1", totalPushed: 10, totalAccepted: 5, totalCompleted: 5, totalRerouted: 0, medianAcceptanceMs: null }],
      [],
    ];
    autoSuspendController.outcome = { scanned: 3, warned: 1, suspended: 0, untouched: 2 };

    await maybeRecomputeReliability();

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(String(logSpy.mock.calls[0][0])).toContain("[reliability]");
    expect(String(logSpy.mock.calls[1][0])).toContain("[auto-suspend]");
    logSpy.mockRestore();
  });

  it("captures a recompute crash instead of throwing (page renders must survive)", async () => {
    // Tick runs on hot paths — a broken query is captured + swallowed, never bubbled.
    dbController.networkControls = [];
    dbController.executeResults = ["THROW"];

    await expect(maybeRecomputeReliability()).resolves.toBeUndefined();

    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: "reliability_recompute" }),
    );
    expect(autoSuspendController.calls).toBe(0); // never reached enforcement
  });
});
