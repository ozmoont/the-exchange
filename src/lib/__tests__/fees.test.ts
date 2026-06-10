import { describe, expect, it } from "vitest";
import { makeSnapshot, systemDefault } from "../fees";
import type { NormalisedBooking } from "../types";

/**
 * Pure fee math — no db, no mocks. Covers makeSnapshot + systemDefault (the
 * money math) directly; the db-backed resolveFeeSnapshot is exercised in the
 * APPENDED block below with the Drizzle client mocked.
 */

const baseBooking: NormalisedBooking = {
  originatorBookingExternalId: "TEST-1",
  bookingType: "asap",
  channel: "app",
  pickup: { lat: 53.349, lng: -6.26, address: "O'Connell St" },
  dropoff: { lat: 53.421, lng: -6.27, address: "Dublin Airport" },
  vehicleType: "standard",
  passengerCount: 1,
  passenger: { name: "Test", phone: "+353 1 000 0000" },
  raw: {},
};

describe("systemDefault", () => {
  it("returns the £0.20 send / £0.40 receive defaults with zero trip fees", () => {
    const d = systemDefault();
    expect(d.sendFeePence).toBe(20);
    expect(d.receiveFeePence).toBe(40);
    expect(d.techFeePence).toBe(0);
    expect(d.techFeeBps).toBe(0);
    expect(d.bookingFeePence).toBe(0);
    expect(d.adminFeePence).toBe(0);
    expect(d.adminFeeBps).toBe(0);
  });
});

describe("makeSnapshot", () => {
  it("produces a zero-trip-fee snapshot from systemDefault on a booking with no fare", () => {
    const snap = makeSnapshot(systemDefault(), "system_default", baseBooking);
    expect(snap.sendFeePence).toBe(20);
    expect(snap.receiveFeePence).toBe(40);
    expect(snap.computedPassengerAddOnsPence).toBe(0);
    expect(snap.fareAtSnapshotPence).toBeNull();
    expect(snap.resolvedFromFeeConfigId).toBe("system_default");
  });

  it("adds fixed trip fees on top of the fare", () => {
    const cfg = {
      ...systemDefault(),
      techFeePence: 100, // £1.00
      bookingFeePence: 200, // £2.00
      adminFeePence: 50, // £0.50
    };
    const snap = makeSnapshot(cfg, "cfg-1", { ...baseBooking, fareEstimatePence: 2500 });
    // 100 (tech) + 200 (booking) + 50 (admin) = 350p of passenger add-ons
    expect(snap.computedPassengerAddOnsPence).toBe(350);
    expect(snap.fareAtSnapshotPence).toBe(2500);
  });

  it("computes percentage-based trip fees against the fare", () => {
    const cfg = {
      ...systemDefault(),
      techFeeBps: 200, // 2%
      adminFeeBps: 300, // 3%
    };
    const snap = makeSnapshot(cfg, "cfg-2", { ...baseBooking, fareEstimatePence: 1000 });
    // tech = 2% of £10 = 20p, admin = 3% of £10 = 30p, total 50p
    expect(snap.computedPassengerAddOnsPence).toBe(50);
  });

  it("combines fixed and percentage fees additively", () => {
    const cfg = {
      ...systemDefault(),
      techFeePence: 100,
      techFeeBps: 100, // 1%
      bookingFeePence: 50,
      adminFeePence: 25,
      adminFeeBps: 200, // 2%
    };
    const snap = makeSnapshot(cfg, "cfg-3", { ...baseBooking, fareEstimatePence: 5000 });
    // tech = 100 + 1% of 5000 = 100 + 50 = 150
    // booking = 50
    // admin = 25 + 2% of 5000 = 25 + 100 = 125
    // total = 150 + 50 + 125 = 325
    expect(snap.computedPassengerAddOnsPence).toBe(325);
  });

  it("treats a missing fare as zero for percentage calculations", () => {
    const cfg = {
      ...systemDefault(),
      techFeePence: 100,
      techFeeBps: 500, // 5%
    };
    const snap = makeSnapshot(cfg, "cfg-4", baseBooking); // no fareEstimatePence
    // tech = 100 + 5% of 0 = 100
    expect(snap.computedPassengerAddOnsPence).toBe(100);
    expect(snap.fareAtSnapshotPence).toBeNull();
  });

  it("rounds percentage fees to the nearest pence (banker's-rounding-free)", () => {
    const cfg = { ...systemDefault(), techFeeBps: 333 }; // 3.33%
    const snap = makeSnapshot(cfg, "cfg-5", { ...baseBooking, fareEstimatePence: 1500 });
    // 3.33% of 1500 = 49.95, rounds to 50
    expect(snap.computedPassengerAddOnsPence).toBe(50);
  });
});

describe("makeSnapshot — determinism (P1-E3 idempotency)", () => {
  // makeSnapshot must be pure: identical inputs → structurally identical
  // output. Fee snapshots are the billing-reconciliation reference, so any
  // non-determinism (clock, randomUUID, FP ordering) would let partners
  // dispute which snapshot is true. Catches that drift.
  it("produces identical output across 100 invocations with identical inputs", () => {
    const cfg = {
      ...systemDefault(),
      techFeePence: 75,
      techFeeBps: 215,
      bookingFeePence: 30,
      adminFeePence: 15,
      adminFeeBps: 187,
    };
    const booking: NormalisedBooking = { ...baseBooking, fareEstimatePence: 4321 };

    const first = makeSnapshot(cfg, "cfg-determinism-1", booking);
    for (let i = 0; i < 100; i++) {
      const next = makeSnapshot(cfg, "cfg-determinism-1", booking);
      expect(next).toStrictEqual(first);
    }
  });

  it("produces different output when only the fare changes", () => {
    const cfg = { ...systemDefault(), techFeeBps: 500 };
    const a = makeSnapshot(cfg, "x", { ...baseBooking, fareEstimatePence: 1000 });
    const b = makeSnapshot(cfg, "x", { ...baseBooking, fareEstimatePence: 2000 });
    expect(a.computedPassengerAddOnsPence).not.toEqual(b.computedPassengerAddOnsPence);
    expect(a.fareAtSnapshotPence).toBe(1000);
    expect(b.fareAtSnapshotPence).toBe(2000);
  });

  it("produces different output when only the config id changes", () => {
    const a = makeSnapshot(systemDefault(), "cfg-A", baseBooking);
    const b = makeSnapshot(systemDefault(), "cfg-B", baseBooking);
    expect(a.resolvedFromFeeConfigId).toBe("cfg-A");
    expect(b.resolvedFromFeeConfigId).toBe("cfg-B");
    // Everything else identical
    expect({ ...a, resolvedFromFeeConfigId: "x" }).toStrictEqual({
      ...b,
      resolvedFromFeeConfigId: "x",
    });
  });

  it("is independent of clock — calling at different wall times produces same snapshot", () => {
    const cfg = { ...systemDefault(), techFeeBps: 200 };
    const booking = { ...baseBooking, fareEstimatePence: 3333 };
    const a = makeSnapshot(cfg, "cfg-clock", booking);
    // A later call must match — no clock drift may leak into the snapshot.
    const later = makeSnapshot(cfg, "cfg-clock", booking);
    expect(later).toStrictEqual(a);
  });

  it("handles every combination of booking type × channel × asap-applicability deterministically", () => {
    const types: Array<"asap" | "prebook"> = ["asap", "prebook"];
    const channels: Array<"app" | "web" | "phone" | "api"> = ["app", "web", "phone", "api"];
    const fares = [0, 100, 1234, 9999, 100000];

    for (const bookingType of types) {
      for (const channel of channels) {
        for (const fareEstimatePence of fares) {
          const booking: NormalisedBooking = {
            ...baseBooking,
            bookingType,
            channel,
            fareEstimatePence,
          };
          const cfg = {
            ...systemDefault(),
            techFeeBps: 250,
            bookingFeePence: 15,
          };
          const a = makeSnapshot(cfg, "cfg-grid", booking);
          const b = makeSnapshot(cfg, "cfg-grid", booking);
          expect(a).toStrictEqual(b);
          // Fare math sanity: pcAddOns should equal tech + booking when no admin
          const expectedTech = 0 + Math.round((fareEstimatePence * 250) / 10000);
          expect(a.computedPassengerAddOnsPence).toBe(expectedTech + 15);
        }
      }
    }
  });
});

// APPENDED — resolveFeeSnapshot (db-backed wrapper). Drizzle mocked at the
// module boundary: each query pops the next canned row-set from a FIFO (pair
// query first, recipient-default only if pair was empty). The hoisted mock
// also covers the top `../fees` import; the pure tests above never touch db.

import { beforeEach, vi } from "vitest";
import { resolveFeeSnapshot } from "../fees";

// FIFO of query results + call counter (pair hit ⇒ recipient-default skipped).
const feeDb = {
  responses: [] as Array<Array<Record<string, unknown>>>,
  selectCalls: 0,
};

vi.mock("@/db/client", () => ({
  db: {
    // drizzle chain select().from().where().orderBy().limit() → next queued
    // row-set; controller referenced lazily so the hoisted factory avoids TDZ.
    select: () => {
      feeDb.selectCalls += 1;
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => feeDb.responses.shift() ?? [],
      };
      return chain;
    },
  },
}));

/** A realistic fee_configs row; overrides let each test flip one rule. */
function feeConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-row-1",
    scope: "pair",
    originatorId: "orig-1",
    recipientId: "rcpt-1",
    sendFeePence: 25,
    receiveFeePence: 45,
    techFeePence: 10,
    techFeeBps: 100, // 1% of fare
    bookingFeePence: 5,
    adminFeePence: 2,
    adminFeeBps: 50, // 0.5% of fare
    applyToAsap: true,
    applyToPrebook: true,
    applyToChannels: ["app", "web", "phone", "api"],
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: "test",
    ...overrides,
  };
}

beforeEach(() => {
  feeDb.responses = [];
  feeDb.selectCalls = 0;
});

describe("resolveFeeSnapshot — config resolution order", () => {
  it("falls back to the hard-coded system default when no config exists at any level", async () => {
    // Step 3: both queries empty → £0.20/£0.40 defaults, zero trip fees.
    feeDb.responses = [[], []]; // pair miss, then recipient-default miss
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", baseBooking);

    expect(snap.resolvedFromFeeConfigId).toBe("system_default");
    expect(snap.sendFeePence).toBe(20);
    expect(snap.receiveFeePence).toBe(40);
    expect(snap.computedPassengerAddOnsPence).toBe(0);
    expect(feeDb.selectCalls).toBe(2); // both levels were consulted
  });

  it("uses the pair-specific config and never runs the recipient-default query", async () => {
    // Step 1 wins: a pair row short-circuits — one SELECT, pair config's math.
    feeDb.responses = [[feeConfigRow()]];
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", {
      ...baseBooking,
      fareEstimatePence: 10000, // £100 fare to make the bps math visible
    });

    expect(snap.resolvedFromFeeConfigId).toBe("cfg-row-1");
    expect(snap.sendFeePence).toBe(25);
    expect(snap.receiveFeePence).toBe(45);
    // tech = 10 + 1% of 10000 = 110; booking = 5; admin = 2 + 0.5% of 10000 = 52
    expect(snap.computedPassengerAddOnsPence).toBe(110 + 5 + 52);
    expect(snap.fareAtSnapshotPence).toBe(10000);
    expect(feeDb.selectCalls).toBe(1); // recipient-default query skipped
  });

  it("falls back to the recipient-level default when no pair config matches", async () => {
    // Step 2: pair query empty → the partner-scoped row applies.
    feeDb.responses = [[], [feeConfigRow({ id: "cfg-recipient-default", scope: "partner" })]];
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", baseBooking);

    expect(snap.resolvedFromFeeConfigId).toBe("cfg-recipient-default");
    expect(snap.sendFeePence).toBe(25);
    expect(feeDb.selectCalls).toBe(2);
  });
});

describe("resolveFeeSnapshot — applicability rules", () => {
  it("skips a config whose applyToChannels excludes the booking's channel", async () => {
    // App-only config must not charge an api booking → system defaults with a
    // distinct audit marker showing WHY they applied.
    feeDb.responses = [[feeConfigRow({ applyToChannels: ["app"] })]];
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", {
      ...baseBooking,
      channel: "api",
    });

    expect(snap.resolvedFromFeeConfigId).toBe("system_default_channel_skip");
    expect(snap.sendFeePence).toBe(20); // system default, not the row's 25
  });

  it("skips a config with applyToAsap=false for an asap booking", async () => {
    feeDb.responses = [[feeConfigRow({ applyToAsap: false })]];
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", {
      ...baseBooking,
      bookingType: "asap",
    });

    expect(snap.resolvedFromFeeConfigId).toBe("system_default_asap_skip");
    expect(snap.receiveFeePence).toBe(40); // defaults, not the row's 45
  });

  it("skips a config with applyToPrebook=false for a prebook booking", async () => {
    feeDb.responses = [[feeConfigRow({ applyToPrebook: false })]];
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", {
      ...baseBooking,
      bookingType: "prebook",
      scheduledFor: "2026-08-01T10:00:00Z",
    });

    expect(snap.resolvedFromFeeConfigId).toBe("system_default_prebook_skip");
  });

  it("applies a prebook-only config to a prebook booking (asap flag irrelevant)", async () => {
    // The two booking-type gates are independent: applyToAsap=false must not
    // block a prebook when applyToPrebook=true.
    feeDb.responses = [[feeConfigRow({ id: "cfg-prebook-only", applyToAsap: false, applyToPrebook: true })]];
    const snap = await resolveFeeSnapshot("orig-1", "rcpt-1", {
      ...baseBooking,
      bookingType: "prebook",
      scheduledFor: "2026-08-01T10:00:00Z",
    });

    expect(snap.resolvedFromFeeConfigId).toBe("cfg-prebook-only");
    expect(snap.sendFeePence).toBe(25);
  });
});
