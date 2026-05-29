import { describe, expect, it } from "vitest";
import { MockICabbiAdapter } from "@/adapters/mock-icabbi";
import { MockCMACAdapter } from "@/adapters/mock-cmac";
import type { PartnerAdapter, NormalisedBooking, CreateBookingInput } from "@/lib/types";
import type { FeeSnapshot } from "@/db/schema";

/**
 * Contract tests for the PartnerAdapter interface. Every adapter MUST satisfy
 * these — they're the floor below which an integration cannot ship. When a
 * real ICabbiAdapter or CMACAdapter is added, run them through the same
 * contract test by adding the constructor to the `cases` array below.
 *
 * Note: this test does not assert business behaviour (that lives in routing
 * tests). It only asserts that the adapter satisfies the interface shape.
 */

const sampleBooking: NormalisedBooking = {
  originatorBookingExternalId: "CONTRACT-TEST-1",
  bookingType: "asap",
  channel: "app",
  pickup: { lat: 53.349, lng: -6.26, address: "Origin" },
  dropoff: { lat: 53.421, lng: -6.27, address: "Destination" },
  vehicleType: "standard",
  passengerCount: 1,
  passenger: { name: "Test", phone: "+353 1 000 0000" },
  raw: {},
};

const sampleFeeSnapshot: FeeSnapshot = {
  sendFeePence: 20,
  receiveFeePence: 40,
  techFeePence: 0,
  techFeeBps: 0,
  bookingFeePence: 0,
  adminFeePence: 0,
  adminFeeBps: 0,
  computedPassengerAddOnsPence: 0,
  fareAtSnapshotPence: null,
  resolvedFromFeeConfigId: "system_default",
};

const sampleInput: CreateBookingInput = {
  transitId: "00000000-0000-0000-0000-000000000abc",
  recipientPartnerId: "11111111-1111-1111-1111-111111111111",
  booking: sampleBooking,
  feeSnapshot: sampleFeeSnapshot,
};

const cases: Array<{ name: string; build: () => PartnerAdapter }> = [
  {
    name: "MockICabbiAdapter",
    build: () => new MockICabbiAdapter("partner-id-1", "test-tenant"),
  },
  {
    name: "MockCMACAdapter",
    build: () => new MockCMACAdapter("partner-id-2"),
  },
];

describe.each(cases)("$name satisfies PartnerAdapter contract", ({ build }) => {
  it("exposes the required identity fields", () => {
    const a = build();
    expect(typeof a.key).toBe("string");
    expect(a.key.length).toBeGreaterThan(0);
    expect(typeof a.partnerId).toBe("string");
  });

  it("createBooking returns an externalId and an acceptedAt ISO timestamp", async () => {
    const a = build();
    const r = await a.createBooking(sampleInput);
    expect(typeof r.externalId).toBe("string");
    expect(r.externalId.length).toBeGreaterThan(0);
    // ISO 8601 — Date can parse and round-trip
    expect(Number.isNaN(Date.parse(r.acceptedAt))).toBe(false);
  });

  it("cancelBooking resolves without throwing", async () => {
    const a = build();
    await expect(a.cancelBooking({ externalId: "EXT-1", reason: "test" })).resolves.toBeUndefined();
  });

  it("normaliseInboundWebhook returns null for an unrecognised payload", async () => {
    const a = build();
    const result = await a.normaliseInboundWebhook({ type: "unknown.shape" });
    expect(result).toBeNull();
  });
});
