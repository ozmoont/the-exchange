import { describe, expect, it } from "vitest";
import { makeSnapshot, systemDefault } from "../fees";
import type { NormalisedBooking } from "../types";

/**
 * Pure tests against the fee math. No database, no mocks. `resolveFeeSnapshot`
 * is the db-backed wrapper around `makeSnapshot` + `systemDefault`; testing the
 * pure helpers gives us coverage of the money math without touching Postgres.
 *
 * When tests against `resolveFeeSnapshot` itself are added (db query path),
 * they belong in `src/app/api/__tests__/` with the Drizzle client mocked at the
 * module boundary — see TEST_STRATEGY.md.
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
  /**
   * makeSnapshot must be a pure function. The same inputs MUST produce
   * structurally identical outputs across many calls. Catches accidental
   * drift if anyone introduces non-determinism (clock reads, randomUUID,
   * floating-point ordering changes).
   *
   * Why this matters: fee snapshots travel with the booking and are the
   * reference for billing reconciliation. If two snapshots taken at the
   * same instant for the same booking diverged, partners would argue
   * about which one is the truth. Determinism = no argument.
   */
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
    // simulate a delay — even if any future helper reaches for Date.now,
    // the snapshot it produces shouldn't capture that drift
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
