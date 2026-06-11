import { describe, expect, it, vi } from "vitest";

/**
 * Tier-1 #3 — fan-out synthetic-quote fallback. When an adapter doesn't
 * implement quote(), fanOutQuote must return an "available" quote with a
 * synthetic ETA derived from straight-line distance at 30km/h.
 *
 * We mock the adapter registry to return an adapter without `quote`, then
 * assert the fallback math + ranges.
 */

const mockAdapter = {
  key: "mock_no_quote",
  partnerId: "PARTNER_A",
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
  normaliseInboundWebhook: vi.fn(),
  // no `quote` method
};

vi.mock("@/adapters/registry", () => ({
  getAdapterForPartner: vi.fn(async () => mockAdapter),
}));

import { fanOutQuote } from "@/lib/fan-out-quote";
import type { NormalisedBooking } from "@/lib/types";

const booking: NormalisedBooking = {
  originatorBookingExternalId: "Q-001",
  bookingType: "asap",
  channel: "api",
  pickup: { lat: 51.507, lng: -0.128, address: "Trafalgar Square" },
  dropoff: { lat: 51.47, lng: -0.454, address: "Heathrow T5" },
  vehicleType: "standard",
  passengerCount: 1,
  passenger: { name: "T", phone: "+44" },
  raw: {},
};

describe("fanOutQuote — synthetic fallback", () => {
  it("returns available:true with ETA derived from distance when adapter has no quote()", async () => {
    const results = await fanOutQuote(
      [{ recipientId: "PARTNER_A", centroidLat: 51.507, centroidLng: -0.128 }],
      booking,
    );
    expect(results).toHaveLength(1);
    expect(results[0].quote.available).toBe(true);
    expect(results[0].fromAdapter).toBe(false);
    // Pickup is exactly at the centroid → distance 0 → ETA clamped to MIN (2 min)
    expect(results[0].quote.etaMinutes).toBe(2);
  });

  it("clamps synthetic ETA to MAX when the partner is very far away", async () => {
    const results = await fanOutQuote(
      // Centroid in Sydney, pickup in London — ~17,000km apart
      [{ recipientId: "PARTNER_A", centroidLat: -33.87, centroidLng: 151.21 }],
      booking,
    );
    expect(results[0].quote.available).toBe(true);
    expect(results[0].quote.etaMinutes).toBe(60); // MAX_SYNTHETIC_ETA_MIN
  });

  it("returns a 10-minute default ETA when partner has no centroid", async () => {
    const results = await fanOutQuote(
      [{ recipientId: "PARTNER_A", centroidLat: null, centroidLng: null }],
      booking,
    );
    expect(results[0].quote.available).toBe(true);
    expect(results[0].quote.etaMinutes).toBe(10);
  });

  it("returns empty array on empty candidates", async () => {
    const results = await fanOutQuote([], booking);
    expect(results).toEqual([]);
  });

  it("computes ETA roughly proportional to distance at 30km/h", async () => {
    // Pickup is Trafalgar Square (51.507, -0.128); this centroid is ~24.7km
    // straight-line away, so ETA = (24.7/30)*60 ≈ 50 min. The point of the
    // test is that ETA scales with distance and lands in a sane mid-range —
    // not a single magic number — so we assert a generous band around it.
    const results = await fanOutQuote(
      [{ recipientId: "PARTNER_A", centroidLat: 51.655, centroidLng: -0.396 }],
      booking,
    );
    expect(results[0].quote.available).toBe(true);
    expect(results[0].quote.etaMinutes).toBeGreaterThanOrEqual(30);
    expect(results[0].quote.etaMinutes).toBeLessThanOrEqual(55);
  });
});
