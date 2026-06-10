import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transits, transitEvents, networkControls } from "@/db/schema";

/**
 * Demo-mode background tick (src/lib/demo.ts). maybeTickDemoMode() runs on
 * every render when DISABLE_AUTH=true, so guards matter as much as happy path:
 * hard no-op unless DISABLE_AUTH==="true"; 20s DB cooldown; no tick while the
 * kill switch is on; lifecycle advance (one step, fake driver payload exactly
 * at driver_assigned); spawn (fresh pushed transit from two distinct partners,
 * fees/payload by kind); and post-tick helper isolation (one failing can't
 * break the others). db mocked via an ordered select-queue; helpers mocked.
 */

// db mock: selectQueue entries consumed in call order; an Error entry makes
// that select reject (tests tick-failure containment).
const dbController = {
  selectQueue: [] as Array<Array<Record<string, unknown>> | Error>,
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  selectCount: 0,
  reset() {
    this.selectQueue = [];
    this.updates = [];
    this.inserts = [];
    this.selectCount = 0;
  },
};

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => {
        dbController.selectCount++;
        const next = dbController.selectQueue.shift() ?? [];
        const exec = () => (next instanceof Error ? Promise.reject(next) : Promise.resolve(next));
        return {
          where: () => ({
            limit: () => exec(),
            // demo also awaits `.where(...)` directly (networkControls read)
            then: (
              res?: (rows: unknown) => unknown,
              rej?: (err: unknown) => unknown,
            ) => exec().then(res, rej),
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbController.updates.push({ table, values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        dbController.inserts.push({ table, values });
      },
    }),
  },
}));

// Mocks for the dynamically-imported post-tick helpers.
const helpers = {
  processReceivedTransits: vi.fn(),
  recheckStaleAcceptances: vi.fn(),
  maybeRecomputeReliability: vi.fn(),
  maybeReconcileCompletedTransits: vi.fn(),
  cleanupOldRateLimitRows: vi.fn(),
};
vi.mock("@/lib/routing", () => ({
  processReceivedTransits: (...a: unknown[]) => helpers.processReceivedTransits(...a),
}));
vi.mock("@/lib/reroute", () => ({
  recheckStaleAcceptances: (...a: unknown[]) => helpers.recheckStaleAcceptances(...a),
}));
vi.mock("@/lib/reliability", () => ({
  maybeRecomputeReliability: (...a: unknown[]) => helpers.maybeRecomputeReliability(...a),
}));
vi.mock("@/lib/reconciliation", () => ({
  maybeReconcileCompletedTransits: (...a: unknown[]) => helpers.maybeReconcileCompletedTransits(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  cleanupOldRateLimitRows: (...a: unknown[]) => helpers.cleanupOldRateLimitRows(...a),
}));

import { maybeTickDemoMode } from "@/lib/demo";

const NOW = new Date("2026-06-10T10:00:00.000Z");
const ORIGINAL_DISABLE_AUTH = process.env.DISABLE_AUTH;

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbController.reset();
  process.env.DISABLE_AUTH = "true";
  // Quiet defaults: helpers succeed with nothing to report.
  helpers.processReceivedTransits.mockReset().mockResolvedValue({ scanned: 0, pushed: 0, no_match: 0, error: 0 });
  helpers.recheckStaleAcceptances.mockReset().mockResolvedValue([]);
  helpers.maybeRecomputeReliability.mockReset().mockResolvedValue(undefined);
  helpers.maybeReconcileCompletedTransits.mockReset().mockResolvedValue(undefined);
  helpers.cleanupOldRateLimitRows.mockReset().mockResolvedValue(undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_DISABLE_AUTH === undefined) delete process.env.DISABLE_AUTH;
  else process.env.DISABLE_AUTH = ORIGINAL_DISABLE_AUTH;
});

/** Queue a "full tick, nothing interesting": control row, in-flight, partners. */
function queueIdleTick(control: Array<Record<string, unknown>> = []) {
  dbController.selectQueue.push(control); // networkControls
  dbController.selectQueue.push([]); // in-flight transits → none
  dbController.selectQueue.push([]); // active partners → none (spawn no-ops)
}

describe("maybeTickDemoMode — guards", () => {
  it("is a hard no-op when DISABLE_AUTH is not 'true'", async () => {
    // Wired into the root layout — in prod (DISABLE_AUTH unset) it must not
    // touch the DB at all.
    delete process.env.DISABLE_AUTH;
    await maybeTickDemoMode();
    expect(dbController.selectCount).toBe(0);
    expect(dbController.updates).toHaveLength(0);
  });

  it("skips when the last tick was inside the 20s cooldown", async () => {
    // The cooldown is all that stops a DB write per render. Inside the
    // window: one read, zero writes.
    dbController.selectQueue.push([
      { id: "global", killSwitch: false, lastDemoTickAt: new Date(NOW.getTime() - 5_000) },
    ]);
    await maybeTickDemoMode();
    expect(dbController.selectCount).toBe(1);
    expect(dbController.updates).toHaveLength(0);
  });

  it("ticks again once exactly 20s have elapsed (strict < comparison)", async () => {
    // Boundary: elapsed == COOLDOWN_MS must tick (skip check is strict <).
    queueIdleTick([{ id: "global", killSwitch: false, lastDemoTickAt: new Date(NOW.getTime() - 20_000) }]);
    await maybeTickDemoMode();
    expect(dbController.updates).toHaveLength(1); // lastDemoTickAt claimed
    expect(dbController.updates[0].table).toBe(networkControls);
    expect(dbController.updates[0].values).toEqual({ lastDemoTickAt: NOW });
  });

  it("does not tick while the kill switch is engaged", async () => {
    // A transit advancing while the dashboard says "paused" undermines the
    // demo — the kill-switch check short-circuits.
    dbController.selectQueue.push([{ id: "global", killSwitch: true, lastDemoTickAt: null }]);
    await maybeTickDemoMode();
    expect(dbController.updates).toHaveLength(0);
  });

  it("ticks when no control row exists yet (fresh database)", async () => {
    // Fresh DB: no row → no lastTick → proceed.
    queueIdleTick([]);
    await maybeTickDemoMode();
    expect(dbController.updates).toHaveLength(1);
  });
});

describe("maybeTickDemoMode — lifecycle advance", () => {
  it("advances one in-flight transit a single step and records the event", async () => {
    // pushed → accepted: row updated + transit_event with demo_tick marker.
    vi.spyOn(Math, "random").mockReturnValue(0); // pick inFlight[0]
    dbController.selectQueue.push([]); // control
    dbController.selectQueue.push([{ id: "tr_1", status: "pushed" }]); // in-flight
    await maybeTickDemoMode();

    // updates: [0] lastDemoTickAt claim, [1] transit status advance
    expect(dbController.updates[1].table).toBe(transits);
    expect(dbController.updates[1].values.status).toBe("accepted");
    const evt = dbController.inserts.find((i) => i.table === transitEvents);
    expect(evt?.values).toMatchObject({
      transitId: "tr_1",
      status: "accepted",
      detail: { source: "demo_tick" },
      actor: "system",
    });
  });

  it("attaches a fake driver payload exactly when the step lands on driver_assigned", async () => {
    // Driver panel needs concrete data; demo injects a Karhoo-shaped
    // DriverDetails sample at this one transition.
    vi.spyOn(Math, "random").mockReturnValue(0); // transit[0] + driver sample[0]
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([{ id: "tr_2", status: "accepted" }]); // → driver_assigned
    await maybeTickDemoMode();

    const evt = dbController.inserts.find((i) => i.table === transitEvents);
    expect(evt?.values.status).toBe("driver_assigned");
    const detail = evt?.values.detail as Record<string, unknown>;
    expect(detail.source).toBe("demo_tick");
    // Math.random=0 deterministically picks the first driver sample.
    expect(detail.driver).toMatchObject({ first_name: "James", last_name: "Carter" });
    expect(detail.vehicle_license_plate).toBe("LK22 XAB");
  });

  it("does nothing for an in-flight row whose status has no next step", async () => {
    // A status with no next step (enum drift) must return cleanly, not crash.
    vi.spyOn(Math, "random").mockReturnValue(0);
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([{ id: "tr_3", status: "completed" }]);
    await maybeTickDemoMode();
    expect(dbController.updates).toHaveLength(1); // only the tick claim
    expect(dbController.inserts).toHaveLength(0);
  });
});

describe("maybeTickDemoMode — spawning a fresh transit", () => {
  it("spawns a pushed transit between two distinct fleet partners", async () => {
    // Nothing in flight → create activity. Fleet recipient → ASAP/standard,
    // fleet-tier fees, no fare estimate.
    vi.spyOn(Math, "random").mockReturnValue(0); // originator[0]; recipient = first other
    dbController.selectQueue.push([]); // control
    dbController.selectQueue.push([]); // in-flight: none
    dbController.selectQueue.push([
      { id: "p_a", name: "Alpha Cars", status: "active", kind: "icabbi_fleet" },
      { id: "p_b", name: "Beta Cabs", status: "active", kind: "icabbi_fleet" },
    ]);
    await maybeTickDemoMode();

    const ins = dbController.inserts.find((i) => i.table === transits);
    expect(ins).toBeDefined();
    const v = ins!.values;
    expect(v.originatorPartnerId).toBe("p_a");
    expect(v.recipientPartnerId).toBe("p_b");
    expect(v.status).toBe("pushed");
    expect(String(v.originatorBookingExternalId)).toMatch(/^DEMO-\d+-[0-9a-f]{4}$/);
    // recipientExternalId derives from the recipient's first name token.
    expect(String(v.recipientBookingExternalId)).toMatch(/^icabbi-beta-/);
    const payload = v.bookingPayload as Record<string, unknown>;
    expect(payload.bookingType).toBe("asap");
    expect(payload.vehicleType).toBe("standard");
    expect(payload.fareEstimatePence).toBeUndefined();
    // Fleet-tier fee snapshot, no corporate add-ons.
    expect(v.feeSnapshot).toMatchObject({
      sendFeePence: 15,
      receiveFeePence: 30,
      techFeePence: 0,
      bookingFeePence: 0,
      adminFeeBps: 0,
      computedPassengerAddOnsPence: 0,
      fareAtSnapshotPence: null,
      resolvedFromFeeConfigId: "demo_tick",
    });
    expect(v.routingTrace).toEqual({ source: "demo_tick", winner: "p_b" });
  });

  it("uses corporate pricing and prebook/executive shape for an external_corporate recipient", async () => {
    // Corporate recipient (other half of every kind-ternary): fare estimate,
    // exec, prebook, and the corporate fee schedule with add-ons.
    vi.spyOn(Math, "random").mockReturnValue(0); // fare = 3500 + 0
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([
      { id: "p_a", name: "Alpha Cars", status: "active", kind: "icabbi_fleet" },
      { id: "p_corp", name: "Corporate Travel Ltd", status: "active", kind: "external_corporate" },
    ]);
    await maybeTickDemoMode();

    const v = dbController.inserts.find((i) => i.table === transits)!.values;
    const payload = v.bookingPayload as Record<string, unknown>;
    expect(payload.bookingType).toBe("prebook");
    expect(payload.vehicleType).toBe("executive");
    expect(payload.fareEstimatePence).toBe(3500);
    expect(v.feeSnapshot).toMatchObject({
      sendFeePence: 20,
      receiveFeePence: 50,
      techFeePence: 100,
      bookingFeePence: 200,
      adminFeeBps: 300,
      // 100 tech + 200 booking + round(3500 * 300bps) = 300 + 105
      computedPassengerAddOnsPence: 405,
      fareAtSnapshotPence: 3500,
    });
  });

  it("does not spawn with fewer than two active partners", async () => {
    // A route needs an originator AND a distinct recipient.
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([{ id: "p_only", name: "Solo", status: "active", kind: "icabbi_fleet" }]);
    await maybeTickDemoMode();
    expect(dbController.inserts.find((i) => i.table === transits)).toBeUndefined();
  });

  it("does not spawn when every candidate shares the originator's id", async () => {
    // Partner list collapsing to one distinct id → no recipient → bail out.
    vi.spyOn(Math, "random").mockReturnValue(0);
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([]);
    dbController.selectQueue.push([
      { id: "p_dup", name: "Dup", status: "active", kind: "icabbi_fleet" },
      { id: "p_dup", name: "Dup", status: "active", kind: "icabbi_fleet" },
    ]);
    await maybeTickDemoMode();
    expect(dbController.inserts.find((i) => i.table === transits)).toBeUndefined();
  });
});

describe("maybeTickDemoMode — post-tick helper isolation", () => {
  it("logs the drain summary when received transits were processed", async () => {
    // The console line is how you see the demo drain backlogged transits.
    queueIdleTick();
    helpers.processReceivedTransits.mockResolvedValue({ scanned: 3, pushed: 2, no_match: 1, error: 0 });
    await maybeTickDemoMode();
    expect(helpers.processReceivedTransits).toHaveBeenCalledWith(20);
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("[demo] drained 3 received transit(s): pushed=2 no_match=1 error=0");
  });

  it("logs reroutes only when at least one transit actually rerouted", async () => {
    // Zero 'rerouted' stays silent — the log line is a signal, not noise.
    queueIdleTick();
    helpers.recheckStaleAcceptances.mockResolvedValue([
      { transitId: "a", outcome: "rerouted" },
      { transitId: "b", outcome: "no_more_candidates" },
    ]);
    await maybeTickDemoMode();
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("[demo] rerouted 1 stale-accept transit(s)");
  });

  it("stays silent when stale checks found outcomes but none rerouted", async () => {
    queueIdleTick();
    helpers.recheckStaleAcceptances.mockResolvedValue([{ transitId: "a", outcome: "max_attempts" }]);
    await maybeTickDemoMode();
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).not.toContain("rerouted");
  });

  it("contains a tick failure and still runs every post-tick helper", async () => {
    // A tick error (DB hiccup) warns and continues — every post-tick helper
    // still runs.
    dbController.selectQueue.push([]); // control
    dbController.selectQueue.push(new Error("transit scan failed")); // tickOnce select rejects
    await maybeTickDemoMode();

    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("[demo] tick failed: transit scan failed");
    expect(helpers.processReceivedTransits).toHaveBeenCalled();
    expect(helpers.recheckStaleAcceptances).toHaveBeenCalled();
    expect(helpers.maybeRecomputeReliability).toHaveBeenCalled();
    expect(helpers.maybeReconcileCompletedTransits).toHaveBeenCalled();
    expect(helpers.cleanupOldRateLimitRows).toHaveBeenCalled();
  });

  it("warns per failing helper, except rate-limit GC which fails silently", async () => {
    // Each helper has its own try/catch: four warn; rate-limit GC is silent.
    queueIdleTick();
    helpers.processReceivedTransits.mockRejectedValue(new Error("drain boom"));
    helpers.recheckStaleAcceptances.mockRejectedValue(new Error("reroute boom"));
    helpers.maybeRecomputeReliability.mockRejectedValue(new Error("reliability boom"));
    helpers.maybeReconcileCompletedTransits.mockRejectedValue(new Error("reconcile boom"));
    helpers.cleanupOldRateLimitRows.mockRejectedValue(new Error("gc boom"));

    await expect(maybeTickDemoMode()).resolves.toBeUndefined();

    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("[demo] drain failed: drain boom");
    expect(warned).toContain("[demo] reroute check failed: reroute boom");
    expect(warned).toContain("[demo] reliability compute failed: reliability boom");
    expect(warned).toContain("[demo] reconciliation failed: reconcile boom");
    expect(warned).not.toContain("gc boom"); // silent by design
  });
});
