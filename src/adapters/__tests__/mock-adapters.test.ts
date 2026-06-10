import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockICabbiAdapter } from "@/adapters/mock-icabbi";
import { MockCMACAdapter } from "@/adapters/mock-cmac";
import { MockFreeNowAdapter } from "@/adapters/mock-freenow";
import type { CreateBookingInput, NormalisedBooking } from "@/lib/types";
import type { FeeSnapshot } from "@/db/schema";

/**
 * Behavioural tests for the three dev/demo/smoke-test mock adapters.
 * Complements adapter-contract.test.ts (which proves interface shape) by
 * locking in: deterministic externalId formats (smoke test asserts them),
 * each mock's inbound-webhook catalogue + defaults, synthetic payment
 * summaries (reconciliation demo depends on them), and MockFreeNow end-to-end
 * (not in the contract test; the only mock implementing quote()).
 */

const sampleBooking: NormalisedBooking = {
  originatorBookingExternalId: "ORIG-9",
  bookingType: "asap",
  channel: "app",
  pickup: { lat: 53.349, lng: -6.26, address: "Origin Street" },
  dropoff: { lat: 53.421, lng: -6.27, address: "Destination Road" },
  vehicleType: "standard",
  passengerCount: 1,
  passenger: { name: "Demo", phone: "+353 1 111 1111" },
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
  transitId: "deadbeef-0000-0000-0000-000000000000",
  recipientPartnerId: "11111111-1111-1111-1111-111111111111",
  booking: sampleBooking,
  feeSnapshot: sampleFeeSnapshot,
};

// All three mocks console.log on every call — silence + restore.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("MockICabbiAdapter", () => {
  const adapter = new MockICabbiAdapter("partner-mi", "tenA");

  it("creates deterministic externalIds: mock-icabbi-{tenant}-{transitId[0..8]}", async () => {
    // The smoke test asserts this exact format — the mock's one hard contract.
    const r = await adapter.createBooking(sampleInput);
    expect(r.externalId).toBe("mock-icabbi-tenA-deadbeef");
    expect(Number.isNaN(Date.parse(r.acceptedAt))).toBe(false);
  });

  it("normalises booking.network_send into a create with the booking's own values", async () => {
    // The fire-jobs script sends this shape; every explicit field passes through.
    const r = await adapter.normaliseInboundWebhook({
      type: "booking.network_send",
      booking: {
        id: 4711,
        bookingType: "prebook",
        channel: "web",
        pickup: { lat: 1, lng: 2, address: "P" },
        dropoff: { lat: 3, lng: 4, address: "D" },
        scheduledFor: "2026-07-02T08:00:00Z",
        vehicleType: "exec",
        passengerCount: 2,
        fareEstimatePence: 1500,
        passenger: { name: "N", phone: "07" },
        notes: "note",
      },
    });

    expect(r?.kind).toBe("create");
    if (r?.kind !== "create") return;
    expect(r.booking).toMatchObject({
      originatorBookingExternalId: "4711",
      bookingType: "prebook",
      channel: "web",
      scheduledFor: "2026-07-02T08:00:00Z",
      vehicleType: "exec",
      passengerCount: 2,
      fareEstimatePence: 1500,
      notes: "note",
    });
  });

  it("applies defaults (asap/app/standard/1 pax) when the inbound booking omits fields", async () => {
    // Minimal seed payloads rely on these defaults — dropping them breaks
    // every local dev booking.
    const r = await adapter.normaliseInboundWebhook({
      type: "booking.network_send",
      booking: { id: 1, pickup: {}, dropoff: {}, passenger: {} },
    });
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking).toMatchObject({
      bookingType: "asap",
      channel: "app",
      vehicleType: "standard",
      passengerCount: 1,
    });
  });

  it("normalises booking.status_update into a status event carrying the raw payload", async () => {
    const payload = {
      type: "booking.status_update",
      recipientBookingExternalId: "EXT-5",
      status: "completed",
    };
    const r = await adapter.normaliseInboundWebhook(payload);
    expect(r).toEqual({
      kind: "status",
      recipientBookingExternalId: "EXT-5",
      newStatus: "completed",
      detail: payload,
    });
  });

  it("synthesises a PROCESSED payment with fixed fee fields and an in-range total", async () => {
    // Demo reconciliation compares against this. Math.random=0.5 → jitter 0,
    // so the total is seed-determined and lands in the £5–£35 band.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const p1 = await adapter.fetchBookingPayment("mock-icabbi-tenA-deadbeef");
    const p2 = await adapter.fetchBookingPayment("mock-icabbi-tenA-deadbeef");

    expect(p1).not.toBeNull();
    expect(p1?.status).toBe("PROCESSED");
    expect(p1?.feePence).toBe(20);
    expect(p1?.processingFeePence).toBe(0);
    expect(typeof p1?.fixedFare).toBe("boolean"); // seed-derived flag
    expect(p1?.totalPence).toBeGreaterThanOrEqual(500);
    expect(p1?.totalPence).toBeLessThanOrEqual(3500);
    // Deterministic given the same external id + pinned jitter.
    expect(p2?.totalPence).toBe(p1?.totalPence);
  });
});

describe("MockCMACAdapter", () => {
  const adapter = new MockCMACAdapter("partner-cm");

  it("creates deterministic externalIds: mock-cmac-{transitId[0..8]}", async () => {
    const r = await adapter.createBooking(sampleInput);
    expect(r.externalId).toBe("mock-cmac-deadbeef");
  });

  it("normalises cmac.booking_request as a corporate PREBOOK via the api channel", async () => {
    // CMAC is a corporate aggregator — always prebook/api with an exec
    // default. That skew makes demo data look corporate, so it's pinned.
    const r = await adapter.normaliseInboundWebhook({
      type: "cmac.booking_request",
      data: {
        reference: "CM-77",
        pickup: { lat: 1, lng: 2, address: "P" },
        dropoff: { lat: 3, lng: 4, address: "D" },
        scheduledFor: "2026-07-03T07:30:00Z",
        traveller: { name: "Exec", phone: "01" },
      },
    });

    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking).toMatchObject({
      originatorBookingExternalId: "CM-77",
      bookingType: "prebook",
      channel: "api",
      vehicleType: "executive", // default when not specified
      passengerCount: 1, // pax default
      scheduledFor: "2026-07-03T07:30:00Z",
    });
  });

  it("respects explicit vehicleType and pax when CMAC provides them", async () => {
    const r = await adapter.normaliseInboundWebhook({
      type: "cmac.booking_request",
      data: { reference: "CM-78", scheduledFor: "2026-07-03T08:00:00Z", vehicleType: "mpv", pax: 5 },
    });
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.vehicleType).toBe("mpv");
    expect(r.booking.passengerCount).toBe(5);
  });

  it("normalises cmac.status_update into a status event", async () => {
    const r = await adapter.normaliseInboundWebhook({
      type: "cmac.status_update",
      recipientBookingExternalId: "CM-EXT-1",
      status: "cancelled",
    });
    expect(r).toMatchObject({
      kind: "status",
      recipientBookingExternalId: "CM-EXT-1",
      newStatus: "cancelled",
    });
  });

  it("synthesises a fully deterministic INVOICED payment (no jitter at all)", async () => {
    // Unlike MockICabbi, no Math.random — repeat calls byte-identical, with
    // the corporate fee structure.
    const p1 = await adapter.fetchBookingPayment("mock-cmac-deadbeef");
    const p2 = await adapter.fetchBookingPayment("mock-cmac-deadbeef");

    expect(p1).toEqual(p2);
    expect(p1).toMatchObject({
      status: "INVOICED",
      feePence: 50,
      processingFeePence: 100,
      fixedFare: true,
    });
    // Documented corporate band: £8–£48.
    expect(p1!.totalPence).toBeGreaterThanOrEqual(800);
    expect(p1!.totalPence).toBeLessThanOrEqual(4800);
  });
});

// MockFreeNowAdapter — full pass; not covered by the contract test.
describe("MockFreeNowAdapter", () => {
  const adapter = new MockFreeNowAdapter("partner-fn");

  it("exposes the identity fields the registry depends on", () => {
    // key must equal partners.adapterKey "mock_freenow" or the outbound flow
    // crashes at the push step.
    expect(adapter.key).toBe("mock_freenow");
    expect(adapter.partnerId).toBe("partner-fn");
  });

  it("creates deterministic externalIds: mock-freenow-{transitId[0..8]} with ISO acceptedAt", async () => {
    const r = await adapter.createBooking(sampleInput);
    expect(r.externalId).toBe("mock-freenow-deadbeef");
    expect(Number.isNaN(Date.parse(r.acceptedAt))).toBe(false);
  });

  it("cancelBooking resolves without throwing (fire-and-forget mock)", async () => {
    await expect(
      adapter.cancelBooking({ externalId: "mock-freenow-x", reason: "demo" }),
    ).resolves.toBeUndefined();
  });

  it("normaliseInboundWebhook always returns null — FreeNow Dummy is outbound-only", async () => {
    // Ignore even a payload that looks like another mock's — this adapter is
    // a destination, not a webhook source, until H2.
    expect(await adapter.normaliseInboundWebhook()).toBeNull();
  });

  it("synthesises a deterministic completed payment in the £12–£42 urban band", async () => {
    const p1 = await adapter.fetchBookingPayment("mock-freenow-deadbeef");
    const p2 = await adapter.fetchBookingPayment("mock-freenow-deadbeef");

    expect(p1).toEqual(p2); // pure hash of the external id — no randomness
    expect(p1).toMatchObject({
      status: "completed",
      feePence: 200,
      processingFeePence: 50,
      fixedFare: false,
    });
    expect(p1!.totalPence).toBeGreaterThanOrEqual(1200);
    expect(p1!.totalPence).toBeLessThanOrEqual(4200);
  });

  it("quote() reports available with a 5-minute ETA for standard vehicles", async () => {
    // Fan-out ranks candidates by these numbers — shifting them reorders demo
    // routing results.
    const q = await adapter.quote({ booking: { ...sampleBooking, fareEstimatePence: 950 } });
    expect(q).toEqual({
      available: true,
      etaMinutes: 5,
      fareEstimatePence: 950, // passthrough of the originator's estimate
      currency: "GBP",
    });
  });

  it("quote() returns a longer 8-minute ETA for exec vehicles (visible ranking spread)", async () => {
    const q = await adapter.quote({ booking: { ...sampleBooking, vehicleType: "exec" } });
    expect(q.available).toBe(true);
    expect(q.etaMinutes).toBe(8);
  });
});
