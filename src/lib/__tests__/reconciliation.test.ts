import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Post-completion reconciliation (reconcileCompletedTransits +
 * maybeReconcileCompletedTransits). After completion we fetch each side's
 * actual billing via adapters' fetchBookingPayment and compare totals.
 * Properties locked in:
 *   - drift flag rule: >50p floor AND >5% of the larger total
 *   - right external id → right adapter (no cross-wiring)
 *   - idempotency: even "neither side knows" stamps reconciledAt so the
 *     hourly scan stops grinding
 *   - a flagged transit writes a fee-category audit row with exact totals
 *   - the demo-tick wrapper honours its 1h cooldown and never lets a crash
 *     escape to the page render
 * db / adapters / observability mocked. The select mock is a queue because
 * maybeReconcile issues two selects (networkControls bare, transits via
 * .limit()) in a fixed order.
 */

// Each db.select() consumes the next queued handler on resolve (.limit() or
// await). A throwing handler simulates a DB failure.
const dbController: {
  selectQueue: Array<() => Array<Record<string, unknown>>>;
  updates: Array<{ table: unknown; set: Record<string, unknown> }>;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
} = { selectQueue: [], updates: [], inserts: [] };

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => {
        const resolveRows = () => {
          const handler = dbController.selectQueue.shift();
          if (!handler) throw new Error("unexpected db.select — test queue empty");
          return handler();
        };
        // Chain supports both shapes: .where().limit() (transits scan) and
        // awaited .where() (networkControls read, thenable).
        const chain = {
          where: () => chain,
          limit: async () => resolveRows(),
          then: (
            onFulfilled: (rows: Array<Record<string, unknown>>) => unknown,
            onRejected: (err: unknown) => unknown,
          ) => Promise.resolve().then(resolveRows).then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          dbController.updates.push({ table, set: v });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        dbController.inserts.push({ table, values: v });
      },
    }),
  },
}));

// Adapter registry mock: partnerId → fake adapter. Absent entries resolve
// to an adapter without fetchBookingPayment (optional-method path); throwFor
// simulates an adapter blowing up.
const adapterController: {
  adapters: Record<string, { fetchBookingPayment?: (id: string) => Promise<{ totalPence: number | null } | null> }>;
  calls: string[];
  throwFor: string | null;
} = { adapters: {}, calls: [], throwFor: null };

vi.mock("@/adapters/registry", () => ({
  getAdapterForPartner: async (partnerId: string) => {
    adapterController.calls.push(partnerId);
    if (adapterController.throwFor === partnerId) {
      throw new Error(`adapter boom for ${partnerId}`);
    }
    return adapterController.adapters[partnerId] ?? {};
  },
}));

// captureError sink — per-transit crashes and wrapper crashes both report here.
const capturedErrors: Array<{ err: unknown; ctx: Record<string, unknown> }> = [];
vi.mock("@/lib/observability", () => ({
  captureError: (err: unknown, ctx: Record<string, unknown>) => capturedErrors.push({ err, ctx }),
}));

import {
  reconcileCompletedTransits,
  maybeReconcileCompletedTransits,
} from "@/lib/reconciliation";
import { transits, networkControls, auditLog } from "@/db/schema";

const NOW = new Date("2026-06-10T12:00:00.000Z");

/** A completed, not-yet-reconciled transit row. */
function transitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tr_1",
    status: "completed",
    originatorPartnerId: "ptr_orig",
    originatorBookingExternalId: "ORIG-EXT-1",
    recipientPartnerId: "ptr_recv",
    recipientBookingExternalId: "RECV-EXT-1",
    feeSnapshot: { receiveFeePence: 120 },
    reconciledAt: null,
    ...overrides,
  };
}

/** Register an adapter whose fetchBookingPayment returns a fixed total. */
function adapterReturning(partnerId: string, totalPence: number | null | "null-payment") {
  adapterController.adapters[partnerId] = {
    fetchBookingPayment: async () =>
      totalPence === "null-payment" ? null : { totalPence },
  };
}

beforeEach(() => {
  dbController.selectQueue = [];
  dbController.updates = [];
  dbController.inserts = [];
  adapterController.adapters = {};
  adapterController.calls = [];
  adapterController.throwFor = null;
  capturedErrors.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileCompletedTransits — scan & skip paths", () => {
  it("returns all-zero counters when no completed transits are pending", async () => {
    // Empty scan touches no adapter and writes nothing.
    dbController.selectQueue = [() => []];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toEqual({ scanned: 0, reconciled: 0, flagged: 0, skipped: 0, error: 0 });
    expect(adapterController.calls).toHaveLength(0);
    expect(dbController.updates).toHaveLength(0);
  });

  it("skips a transit with no recipient assignment without calling any adapter", async () => {
    // Unrouted transit has nothing to compare and must burn no adapter calls.
    dbController.selectQueue = [
      () => [transitRow({ recipientPartnerId: null, recipientBookingExternalId: null })],
    ];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ scanned: 1, skipped: 1, reconciled: 0 });
    expect(adapterController.calls).toHaveLength(0);
    // Intentional: skip leaves reconciledAt null → re-scanned until routed.
    expect(dbController.updates).toHaveLength(0);
  });

  it("stamps reconciledAt (and nothing else) when NEITHER adapter can report a payment", async () => {
    // Idempotency: adapters lacking fetchBookingPayment (`?.` path) still
    // mark the transit done, or the hourly scan retries forever.
    dbController.selectQueue = [() => [transitRow()]];
    // No adapters → both resolve to {} with no fetchBookingPayment.

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ scanned: 1, skipped: 1, reconciled: 0 });

    expect(dbController.updates).toHaveLength(1);
    const { table, set } = dbController.updates[0];
    expect(table).toBe(transits);
    expect(set.reconciledAt).toBeInstanceOf(Date);
    expect(set.reconciledOriginatorTotalPence).toBeUndefined(); // empty reconcile stores no totals
  });

  it("also treats fetchBookingPayment returning null on both sides as reconciled-but-empty", async () => {
    // Same skip when the method exists but the API has no payment (cash trip).
    adapterReturning("ptr_orig", "null-payment");
    adapterReturning("ptr_recv", "null-payment");
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ skipped: 1 });
    expect(dbController.updates[0].set.reconciledAt).toBeInstanceOf(Date);
  });
});

describe("reconcileCompletedTransits — totals, drift & flag thresholds", () => {
  it("fetches each side's payment with the CORRECT external id (no cross-wiring)", async () => {
    // Each adapter must get its own side's booking id; swapping would
    // compare unrelated bookings and produce garbage drift.
    const seenIds: Record<string, string> = {};
    adapterController.adapters["ptr_orig"] = {
      fetchBookingPayment: async (id) => ((seenIds.orig = id), { totalPence: 1000 }),
    };
    adapterController.adapters["ptr_recv"] = {
      fetchBookingPayment: async (id) => ((seenIds.recv = id), { totalPence: 1000 }),
    };
    dbController.selectQueue = [() => [transitRow()]];

    await reconcileCompletedTransits();
    expect(seenIds).toEqual({ orig: "ORIG-EXT-1", recv: "RECV-EXT-1" });
    expect(adapterController.calls).toEqual(["ptr_orig", "ptr_recv"]);
  });

  it("reconciles matching totals with zero drift and no flag", async () => {
    // Both sides agree → drift 0, not flagged, no audit-log noise.
    adapterReturning("ptr_orig", 1000);
    adapterReturning("ptr_recv", 1000);
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ reconciled: 1, flagged: 0 });

    const { set } = dbController.updates[0];
    expect(set).toMatchObject({
      reconciledOriginatorTotalPence: 1000,
      reconciledRecipientTotalPence: 1000,
      reconciledDriftPence: 0,
      reconciledFlagged: false,
    });
    expect(dbController.inserts).toHaveLength(0);
  });

  it("flags drift above BOTH the 50p floor and the 5% threshold, with a fee audit row", async () => {
    // 1000p drift on 5000p (20%) flags AND leaves exact numbers in the audit
    // trail for the dispute paper-trail.
    adapterReturning("ptr_orig", 6000);
    adapterReturning("ptr_recv", 5000);
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ reconciled: 1, flagged: 1 });
    expect(dbController.updates[0].set).toMatchObject({
      reconciledDriftPence: 1000,
      reconciledFlagged: true,
    });

    expect(dbController.inserts).toHaveLength(1);
    const { table, values } = dbController.inserts[0];
    expect(table).toBe(auditLog);
    expect(values).toMatchObject({
      category: "fee",
      actor: "system",
      action: "transit.reconciliation_flagged",
      subjectType: "transit",
      subjectId: "tr_1",
      after: {
        originatorTotalPence: 6000,
        recipientTotalPence: 5000,
        driftPence: 1000,
        feeSnapshotReceiveFeePence: 120, // pulled from the locked feeSnapshot
      },
    });
  });

  it("does NOT flag drift above 50p when it is within 5% of a large booking", async () => {
    // Percentage guard: 60p on 10000p is 0.6% — noise on big fares, no page.
    adapterReturning("ptr_orig", 10_060);
    adapterReturning("ptr_recv", 10_000);
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ reconciled: 1, flagged: 0 });
    expect(dbController.updates[0].set).toMatchObject({
      reconciledDriftPence: 60,
      reconciledFlagged: false,
    });
  });

  it("does NOT flag large-percentage drift that stays under the 50p floor", async () => {
    // Floor guard: 40p on 100p is 40% but immaterial — micro-fares don't flag.
    adapterReturning("ptr_orig", 140);
    adapterReturning("ptr_recv", 100);
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome.flagged).toBe(0);
    expect(dbController.updates[0].set.reconciledFlagged).toBe(false);
  });

  it("drift exactly AT the 50p floor does not flag (strict > comparison)", async () => {
    // Boundary: rule is "> 50p" not ">=", so 50p stays unflagged.
    adapterReturning("ptr_orig", 150);
    adapterReturning("ptr_recv", 100);
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome.flagged).toBe(0);
  });

  it("stores partial totals with NULL drift when only one side reported", async () => {
    // One-sided data: drift null (not zero!), but persist what we learned.
    adapterReturning("ptr_orig", 2000);
    adapterReturning("ptr_recv", "null-payment");
    dbController.selectQueue = [() => [transitRow()]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ reconciled: 1, flagged: 0, skipped: 0 });
    expect(dbController.updates[0].set).toMatchObject({
      reconciledOriginatorTotalPence: 2000,
      reconciledRecipientTotalPence: null,
      reconciledDriftPence: null,
      reconciledFlagged: false,
    });
  });

  it("flags via the denom===0 branch when totals are non-positive (refund-shaped data)", async () => {
    // FLAG (actual behavior): negative originator + zero recipient → larger
    // total 0 → percentage check bypassed, any drift >50p flags. Also covers
    // feeSnapshot=null → audit row stores null.
    adapterReturning("ptr_orig", -200);
    adapterReturning("ptr_recv", 0);
    dbController.selectQueue = [() => [transitRow({ feeSnapshot: null })]];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ reconciled: 1, flagged: 1 });
    expect((dbController.inserts[0].values.after as Record<string, unknown>).feeSnapshotReceiveFeePence).toBeNull();
  });

  it("isolates a crashing adapter: counts error, reports it, and still reconciles the next transit", async () => {
    // One broken adapter must not poison the batch: crash captured with the
    // transit id, next transit completes.
    adapterController.throwFor = "ptr_orig_bad";
    adapterReturning("ptr_orig", 1000);
    adapterReturning("ptr_recv", 1000);
    dbController.selectQueue = [
      () => [
        transitRow({ id: "tr_bad", originatorPartnerId: "ptr_orig_bad" }),
        transitRow({ id: "tr_good" }),
      ],
    ];

    const outcome = await reconcileCompletedTransits();
    expect(outcome).toMatchObject({ scanned: 2, error: 1, reconciled: 1 });
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].ctx).toMatchObject({ area: "reconciliation", transit_id: "tr_bad" });
  });
});

describe("maybeReconcileCompletedTransits — demo-tick cooldown wrapper", () => {
  it("runs when no control row exists and stamps lastReconciliationRunAt first", async () => {
    // First tick: no row → stamp-then-run. Stamp-before-run prevents
    // concurrent renders double-running.
    dbController.selectQueue = [
      () => [], // networkControls read → no row
      () => [], // transits scan inside reconcile → empty
    ];

    await maybeReconcileCompletedTransits();

    expect(dbController.updates).toHaveLength(1);
    const { table, set } = dbController.updates[0];
    expect(table).toBe(networkControls);
    expect((set.lastReconciliationRunAt as Date).getTime()).toBe(NOW.getTime());
    expect(dbController.selectQueue).toHaveLength(0); // both selects consumed
  });

  it("returns early inside the 1h cooldown — no stamp, no scan", async () => {
    // Cooldown is the only thing stopping per-render adapter hammering.
    dbController.selectQueue = [
      () => [{ id: "global", lastReconciliationRunAt: new Date(NOW.getTime() - 30 * 60_000) }],
    ];

    await maybeReconcileCompletedTransits();
    expect(dbController.updates).toHaveLength(0); // no stamp written
    expect(dbController.selectQueue).toHaveLength(0); // transits select never queued/consumed
  });

  it("runs again once the cooldown has elapsed and logs a summary when work was done", async () => {
    // 2h-old stamp → eligible; one reconcilable transit → one-line ops summary.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    adapterReturning("ptr_orig", 1000);
    adapterReturning("ptr_recv", 1000);
    dbController.selectQueue = [
      () => [{ id: "global", lastReconciliationRunAt: new Date(NOW.getTime() - 2 * 60 * 60_000) }],
      () => [transitRow()],
    ];

    await maybeReconcileCompletedTransits();

    const summary = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[reconciliation]"));
    expect(summary).toContain("scanned=1");
    expect(summary).toContain("reconciled=1");
    logSpy.mockRestore();
  });

  it("captures a reconcile crash instead of letting it escape to the page render", async () => {
    // Runs during renders: a scan DB failure must go to observability, not 500.
    dbController.selectQueue = [
      () => [], // no control row → proceed
      () => {
        throw new Error("transits select exploded");
      },
    ];

    await expect(maybeReconcileCompletedTransits()).resolves.toBeUndefined();
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].ctx).toMatchObject({ area: "reconciliation_run" });
  });
});
