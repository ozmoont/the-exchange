import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  BookingPaymentSummary,
  QuoteInput,
  QuoteResult,
} from "@/lib/types";

/**
 * Mock FreeNow adapter.
 *
 * FreeNow is a real demand+supply aggregator we plan to integrate properly
 * in H2 (per STRATEGY.md decision #13 — first non-iCabbi partner is where
 * the configurable mapping layer ships). Until then this mock stands in:
 * it accepts bookings, returns a synthetic external id, and reports
 * synthetic completed payments for reconciliation.
 *
 * Used by the H1.5 outbound flow — when iCabbi offers an overflow booking
 * to The Exchange, FreeNow Dummy is the only non-iCabbi candidate in the
 * seed setup. Without this adapter registered, routing reaches the push
 * step and crashes with "No adapter registered for key 'mock_freenow'".
 */
export class MockFreeNowAdapter implements PartnerAdapter {
  readonly key = "mock_freenow";
  constructor(public readonly partnerId: string) {}

  async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
    // Simulate latency similar to MockICabbi / MockCMAC so the demo feels
    // real — async drain + 80ms is roughly what a real adapter call looks
    // like.
    await new Promise((r) => setTimeout(r, 80));
    const externalId = `mock-freenow-${input.transitId.slice(0, 8)}`;
    console.log(
      `[MockFreeNow] createBooking transit=${input.transitId} externalId=${externalId} ` +
        `pickup=${input.booking.pickup.address} ` +
        `dropoff=${input.booking.dropoff.address} ` +
        `fee=${JSON.stringify(input.feeSnapshot)}`,
    );
    return { externalId, acceptedAt: new Date().toISOString() };
  }

  async cancelBooking({ externalId, reason }: CancelBookingInput): Promise<void> {
    console.log(`[MockFreeNow] cancelBooking ${externalId} reason="${reason}"`);
  }

  async fetchBookingPayment(externalId: string): Promise<BookingPaymentSummary | null> {
    // Deterministic synthetic payment so reconciliation has data to compare.
    // FreeNow real fares would come back from their API; this stand-in
    // returns plausible numbers that vary per external id.
    let h = 1469598103;
    for (let i = 0; i < externalId.length; i++) h = ((h * 31) + externalId.charCodeAt(i)) | 0;
    const seed = (Math.abs(h) % 1000) / 1000;
    const baseGbp = 12 + seed * 30; // £12-£42 typical urban range
    const totalPence = Math.round(baseGbp * 100);
    return {
      totalPence,
      status: "completed",
      feePence: 200, // FreeNow's service fee, plausible
      processingFeePence: 50,
      fixedFare: false,
    };
  }

  async normaliseInboundWebhook(): Promise<null> {
    // FreeNow Dummy doesn't fire real webhooks into The Exchange — it's a
    // mock used as a destination. If the real FreeNow integration lands in
    // H2 this method gets a real implementation against their webhook
    // payload shape.
    return null;
  }

  async quote({ booking }: QuoteInput): Promise<QuoteResult> {
    // Mock: always available, ETA varies with vehicle type to make the
    // fan-out ranking visible during demos. Real FreeNow integration in H2
    // will call their actual quote API.
    await new Promise((r) => setTimeout(r, 60)); // simulate ~60ms RTT
    const etaMinutes = booking.vehicleType === "exec" ? 8 : 5;
    return {
      available: true,
      etaMinutes,
      fareEstimatePence: booking.fareEstimatePence,
      currency: "GBP",
    };
  }
}
