import { describe, expect, it, vi } from "vitest";

/**
 * fan-out synthetic-quote fallback: when an adapter lacks quote(), fanOutQuote
 * returns "available" with a synthetic ETA from straight-line distance at
 * 30km/h. Registry mocked to a quote-less adapter; assert fallback math + ranges.
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
    // Pickup at centroid → distance 0 → ETA clamped to MIN (2 min).
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
    // ~24.7km away → ETA ≈ (24.7/30)*60 ≈ 50 min. Asserts ETA scales with
    // distance into a sane mid-range, not a magic number → generous band.
    const results = await fanOutQuote(
      [{ recipientId: "PARTNER_A", centroidLat: 51.655, centroidLng: -0.396 }],
      booking,
    );
    expect(results[0].quote.available).toBe(true);
    expect(results[0].quote.etaMinutes).toBeGreaterThanOrEqual(30);
    expect(results[0].quote.etaMinutes).toBeLessThanOrEqual(55);
  });
});

// APPENDED — adapter quote() path: success, rejection, the 1500ms timeout
// race (BDD NFR), and the defensive internal-error branch. Each test layers a
// one-shot adapter (mockImplementationOnce) over the no-quote default above.

import { afterEach } from "vitest";
import { getAdapterForPartner } from "@/adapters/registry";
import { QUOTE_FANOUT_TIMEOUT_MS } from "@/lib/fan-out-quote";
import type { PartnerAdapter, QuoteResult } from "@/lib/types";

/** One-shot adapter whose quote() does whatever the test needs. */
function adapterWithQuote(quote: () => Promise<QuoteResult>): PartnerAdapter {
  return { ...mockAdapter, quote } as unknown as PartnerAdapter;
}

const registryMock = vi.mocked(getAdapterForPartner);
const candidate = { recipientId: "PARTNER_Q", centroidLat: 51.5, centroidLng: -0.1 };

describe("fanOutQuote — adapter quote path", () => {
  // Fake timers keep the 1500ms race deterministic and stop a real timer
  // outliving a test.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a successful adapter quote through verbatim with fromAdapter:true", async () => {
    // Happy path: adapter's own availability/eta/fare reach ranking untouched.
    const quote: QuoteResult = { available: true, etaMinutes: 4, fareEstimatePence: 850, currency: "GBP" };
    registryMock.mockResolvedValueOnce(adapterWithQuote(async () => quote));

    const results = await fanOutQuote([candidate], booking);
    expect(results).toHaveLength(1);
    expect(results[0].quote).toEqual(quote);
    expect(results[0].fromAdapter).toBe(true);
    expect(results[0].error).toBeUndefined();
  });

  it("converts a throwing adapter into available:false / quote_error (never throws)", async () => {
    // Contract: fanOutQuote never throws — a crashing adapter becomes
    // unavailable, message preserved for logs.
    registryMock.mockResolvedValueOnce(
      adapterWithQuote(async () => {
        throw new Error("partner exploded");
      }),
    );

    const results = await fanOutQuote([candidate], booking);
    expect(results[0].quote).toEqual({ available: false, reason: "quote_error" });
    expect(results[0].error).toBe("partner exploded");
    expect(results[0].fromAdapter).toBe(true);
  });

  it("classifies any error message containing 'timeout' as quote_timeout", async () => {
    // Reason taxonomy keys off the message: a "timeout" must rank as
    // quote_timeout (not generic error) so slow partners get deprioritised.
    registryMock.mockResolvedValueOnce(
      adapterWithQuote(async () => {
        throw new Error("upstream request timeout");
      }),
    );

    const results = await fanOutQuote([candidate], booking);
    expect(results[0].quote).toEqual({ available: false, reason: "quote_timeout" });
  });

  it("stringifies non-Error rejections into the error field", async () => {
    // Bare-string rejections must not choke the catch path on `err.message`.
    registryMock.mockResolvedValueOnce(
      adapterWithQuote(() => Promise.reject("plain-string-failure")),
    );

    const results = await fanOutQuote([candidate], booking);
    expect(results[0].quote.available).toBe(false);
    expect(results[0].error).toBe("plain-string-failure");
  });

  it("treats a failing registry lookup as quote_error for that candidate", async () => {
    // getAdapterForPartner can throw (unknown partner/bad creds) — it's in
    // quoteOne's try, so same graceful degradation.
    registryMock.mockRejectedValueOnce(new Error("partner not found"));

    const results = await fanOutQuote([candidate], booking);
    expect(results[0].quote).toEqual({ available: false, reason: "quote_error" });
    expect(results[0].error).toBe("partner not found");
  });

  it(`rejects an adapter slower than ${QUOTE_FANOUT_TIMEOUT_MS}ms via the Promise.race timeout (BDD NFR)`, async () => {
    // 1500ms collection window: a never-settling quote loses the race →
    // quote_timeout. Fake timers drive setTimeout, no real waiting.
    vi.useFakeTimers();
    registryMock.mockResolvedValueOnce(
      adapterWithQuote(() => new Promise<QuoteResult>(() => {})), // hangs forever
    );

    const pending = fanOutQuote([candidate], booking);
    await vi.advanceTimersByTimeAsync(QUOTE_FANOUT_TIMEOUT_MS + 1);
    const results = await pending;

    expect(results[0].quote).toEqual({ available: false, reason: "quote_timeout" });
    expect(results[0].error).toBe("quote_timeout");
    expect(results[0].fromAdapter).toBe(true);
  });

  it("a single slow adapter cannot block a fast one — results stay in input order", async () => {
    // NFR's point: candidates raced independently; results are positional
    // (input order), not response order.
    vi.useFakeTimers();
    registryMock
      .mockResolvedValueOnce(adapterWithQuote(() => new Promise<QuoteResult>(() => {}))) // slow
      .mockResolvedValueOnce(adapterWithQuote(async () => ({ available: true, etaMinutes: 3 }))); // fast

    const pending = fanOutQuote(
      [
        { recipientId: "SLOW", centroidLat: null, centroidLng: null },
        { recipientId: "FAST", centroidLat: null, centroidLng: null },
      ],
      booking,
    );
    await vi.advanceTimersByTimeAsync(QUOTE_FANOUT_TIMEOUT_MS + 1);
    const results = await pending;

    expect(results.map((r) => r.recipientId)).toEqual(["SLOW", "FAST"]); // input order preserved
    expect(results[0].quote.reason).toBe("quote_timeout");
    expect(results[1].quote).toEqual({ available: true, etaMinutes: 3 });
  });

  it("maps an unexpected quoteOne rejection to fan_out_internal_error (defensive branch)", async () => {
    // quoteOne catches inside its try, so it can only reject before the try —
    // the startedAt Date.now(). Force that (2nd Date.now call) to exercise
    // fanOutQuote's "should never happen" guard instead of leaving it dead.
    const realNow = Date.now.bind(Date);
    let calls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error("clock exploded");
      return realNow();
    });
    try {
      const results = await fanOutQuote(
        [{ recipientId: "PARTNER_A", centroidLat: null, centroidLng: null }],
        booking,
      );
      expect(results[0].quote).toEqual({ available: false, reason: "fan_out_internal_error" });
      expect(results[0].error).toBe("clock exploded");
      expect(results[0].fromAdapter).toBe(false);
      expect(results[0].elapsedMs).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
