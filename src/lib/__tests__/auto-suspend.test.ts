import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

/**
 * Auto-suspend tests (src/lib/auto-suspend.ts). Transition matrix locked in:
 *   active → warning    rate < 0.6, ≥20 pushes
 *   active → suspended  rate < 0.4, ≥50 pushes
 *   warning → suspended same suspend rule (escalation)
 *   warning/suspended → up  NEVER automatically
 * Plus rails: null-rate untouched, 7-day manual-reactivation cooldown,
 * strict-< thresholds, inclusive-≥ samples, audit row per transition.
 * db mocked: partners select returns test rows; updates + auditLog inserts recorded.
 */

const dbController = {
  /** Rows returned by the active/warning partners scan. */
  partners: [] as unknown[],
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
};

const TABLE_NAMES = new Map<unknown, string>([
  [schema.partners, "partners"],
  [schema.auditLog, "auditLog"],
]);

vi.mock("@/db/client", () => ({
  db: {
    // Single select: the inArray(active,warning) scan.
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dbController.partners),
      }),
    }),
    update: (tbl: unknown) => ({
      set: (v: Record<string, unknown>) => {
        dbController.updates.push({ table: TABLE_NAMES.get(tbl) ?? "unknown", set: v });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    insert: (tbl: unknown) => ({
      values: (v: Record<string, unknown>) => {
        dbController.inserts.push({ table: TABLE_NAMES.get(tbl) ?? "unknown", values: v });
        return Promise.resolve(undefined);
      },
    }),
  },
}));

import { AUTO_SUSPEND_THRESHOLDS, enforceReliabilityThresholds } from "@/lib/auto-suspend";

// Clock pinned to a fixed June-2026 instant; cooldown dates are relative to it.
const NOW = new Date("2026-06-10T12:00:00Z").getTime();

// Partner row with every column the engine reads. Default: healthy active partner.
type PartnerRow = {
  id: string;
  status: string;
  statusReason: string | null;
  acceptanceRate: number | null;
  totalPushed7d: number | null;
  autoSuspendCooldownUntil: Date | null;
};
function partner(over: Partial<PartnerRow> & { id: string }): PartnerRow {
  return {
    status: "active",
    statusReason: null,
    acceptanceRate: 0.9,
    totalPushed7d: 100,
    autoSuspendCooldownUntil: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbController.partners = [];
  dbController.updates = [];
  dbController.inserts = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function statusUpdates() {
  return dbController.updates.filter((u) => u.table === "partners").map((u) => u.set);
}
function auditRows() {
  return dbController.inserts.filter((i) => i.table === "auditLog").map((i) => i.values);
}

describe("enforceReliabilityThresholds — guards", () => {
  it("returns all-zero outcome for an empty partner list", async () => {
    const out = await enforceReliabilityThresholds();
    expect(out).toEqual({ scanned: 0, warned: 0, suspended: 0, untouched: 0 });
  });

  it("leaves partners with no acceptance rate untouched (new fleets)", async () => {
    // Null rate = no data; never punish onboarding regardless of sample.
    dbController.partners = [partner({ id: "p-new", acceptanceRate: null, totalPushed7d: 200 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ scanned: 1, untouched: 1, warned: 0, suspended: 0 });
    expect(statusUpdates()).toHaveLength(0);
  });

  it("respects an active manual-reactivation cooldown even with terrible metrics", async () => {
    // Manual reactivation must not be re-suspended on stale data; cooldown 3d out.
    dbController.partners = [
      partner({
        id: "p-cooling",
        acceptanceRate: 0.1,
        totalPushed7d: 100,
        autoSuspendCooldownUntil: new Date(NOW + 3 * 86_400_000),
      }),
    ];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ untouched: 1, suspended: 0 });
    expect(statusUpdates()).toHaveLength(0);
  });

  it("acts again once the cooldown has expired", async () => {
    // Cooldown in the past → engine back in charge.
    dbController.partners = [
      partner({
        id: "p-cooled",
        acceptanceRate: 0.1,
        totalPushed7d: 100,
        autoSuspendCooldownUntil: new Date(NOW - 1000),
      }),
    ];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ suspended: 1 });
  });

  it("treats a null totalPushed7d as sample 0 (untouched)", async () => {
    // Rate without a sample (?? 0) must not trigger anything.
    dbController.partners = [partner({ id: "p-nosample", acceptanceRate: 0.1, totalPushed7d: null })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ untouched: 1 });
  });

  it("leaves healthy partners alone", async () => {
    // 90% over a big sample → no transition.
    dbController.partners = [partner({ id: "p-good" })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ untouched: 1, warned: 0, suspended: 0 });
  });
});

describe("enforceReliabilityThresholds — suspend", () => {
  it("suspends an active partner below 40% acceptance with ≥50 pushes, with full audit", async () => {
    // Severe transition: status + statusReason written, audit before/after for reconstruction.
    dbController.partners = [
      partner({ id: "p-bad", acceptanceRate: 0.3, totalPushed7d: 60, statusReason: null }),
    ];

    const out = await enforceReliabilityThresholds();

    expect(out).toMatchObject({ suspended: 1, warned: 0 });
    expect(statusUpdates()[0]).toMatchObject({
      status: "suspended",
      statusReason: "acceptance_rate_0.30_over_60_pushed_7d",
    });
    expect(auditRows()[0]).toMatchObject({
      category: "admin",
      actor: "system",
      actorRef: "auto_suspend_engine",
      action: "partner.auto_suspended",
      subjectType: "partner",
      subjectId: "p-bad",
      before: { status: "active", statusReason: null, acceptanceRate: 0.3, totalPushed7d: 60 },
      after: { status: "suspended", statusReason: "acceptance_rate_0.30_over_60_pushed_7d" },
    });
  });

  it("escalates a warning partner straight to suspended", async () => {
    // warning → suspended allowed; audit 'before' must show the warning state.
    dbController.partners = [
      partner({ id: "p-warned", status: "warning", acceptanceRate: 0.2, totalPushed7d: 80 }),
    ];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ suspended: 1 });
    expect(auditRows()[0]).toMatchObject({ before: expect.objectContaining({ status: "warning" }) });
  });

  it("does not suspend at exactly the 40% threshold (strict <)", async () => {
    // rate == threshold is NOT below it; big sample still trips warning (0.4 < 0.6).
    dbController.partners = [partner({ id: "p-edge", acceptanceRate: 0.4, totalPushed7d: 100 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ suspended: 0, warned: 1 });
  });

  it("suspends at exactly the 50-push sample boundary (inclusive ≥)", async () => {
    dbController.partners = [partner({ id: "p-50", acceptanceRate: 0.39, totalPushed7d: 50 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ suspended: 1 });
  });

  it("downgrades a suspend-worthy rate to a warning when the sample is below 50", async () => {
    // Cascade: 0.3/25 fails suspend sample gate but meets warning (0.3<0.6, 25≥20).
    dbController.partners = [partner({ id: "p-midsample", acceptanceRate: 0.3, totalPushed7d: 25 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ suspended: 0, warned: 1 });
    expect(statusUpdates()[0]).toMatchObject({ status: "warning" });
  });

  it("never re-suspends a partner already suspended (defensive branch)", async () => {
    // FLAG (defensive): query filters to active/warning so this is unreachable normally;
    // the in-loop guard exists — locks in untouched, no duplicate audit, if hit.
    dbController.partners = [
      partner({ id: "p-susp", status: "suspended", acceptanceRate: 0.1, totalPushed7d: 100 }),
    ];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ untouched: 1, suspended: 0 });
    expect(auditRows()).toHaveLength(0);
  });
});

describe("enforceReliabilityThresholds — warning", () => {
  it("warns an active partner below 60% acceptance with ≥20 pushes", async () => {
    dbController.partners = [partner({ id: "p-meh", acceptanceRate: 0.5, totalPushed7d: 30 })];

    const out = await enforceReliabilityThresholds();

    expect(out).toMatchObject({ warned: 1, suspended: 0 });
    expect(statusUpdates()[0]).toMatchObject({
      status: "warning",
      statusReason: "acceptance_rate_0.50_over_30_pushed_7d",
    });
    expect(auditRows()[0]).toMatchObject({ action: "partner.auto_warned" });
  });

  it("does not re-warn a partner already at warning (no audit churn)", async () => {
    // Idempotency: a fleet already at warning gets no fresh update/audit each tick.
    dbController.partners = [
      partner({ id: "p-warned", status: "warning", acceptanceRate: 0.5, totalPushed7d: 30 }),
    ];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ untouched: 1, warned: 0 });
    expect(statusUpdates()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("does not warn at exactly the 60% threshold (strict <)", async () => {
    dbController.partners = [partner({ id: "p-edge", acceptanceRate: 0.6, totalPushed7d: 100 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ warned: 0, untouched: 1 });
  });

  it("does not warn below the 20-push sample gate", async () => {
    // 50% over 19 pushes: below the 20-push gate.
    dbController.partners = [partner({ id: "p-small", acceptanceRate: 0.5, totalPushed7d: 19 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ warned: 0, untouched: 1 });
  });

  it("warns at exactly the 20-push sample boundary (inclusive ≥)", async () => {
    dbController.partners = [partner({ id: "p-20", acceptanceRate: 0.5, totalPushed7d: 20 })];

    const out = await enforceReliabilityThresholds();
    expect(out).toMatchObject({ warned: 1 });
  });
});

describe("enforceReliabilityThresholds — aggregate run", () => {
  it("tallies a mixed batch correctly in a single pass", async () => {
    // One of each outcome → counters are independent, each partner visited once.
    dbController.partners = [
      partner({ id: "p-ok" }), // healthy → untouched
      partner({ id: "p-warn", acceptanceRate: 0.5, totalPushed7d: 30 }), // → warned
      partner({ id: "p-susp", acceptanceRate: 0.2, totalPushed7d: 60 }), // → suspended
      partner({ id: "p-null", acceptanceRate: null }), // no data → untouched
    ];

    const out = await enforceReliabilityThresholds();
    expect(out).toEqual({ scanned: 4, warned: 1, suspended: 1, untouched: 2 });
    expect(auditRows()).toHaveLength(2);
  });
});

describe("AUTO_SUSPEND_THRESHOLDS", () => {
  it("exposes the documented threshold constants for the admin UI", () => {
    // Admin screens render these; a change is a product decision, made visible in review.
    expect(AUTO_SUSPEND_THRESHOLDS).toEqual({
      WARN_THRESHOLD: 0.6,
      WARN_SAMPLE: 20,
      SUSPEND_THRESHOLD: 0.4,
      SUSPEND_SAMPLE: 50,
    });
  });
});
