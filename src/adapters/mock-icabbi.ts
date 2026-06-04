import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  NormalisedBooking,
  BookingPaymentSummary,
} from "@/lib/types";

/**
 * Mock iCabbi tenant adapter. Pretends a booking was created on a remote
 * iCabbi fleet. Used in dev + smoke tests. Replace with the real
 * `ICabbiAdapter` (POST to https://<tenant>.icabbi.com/api/v3/bookings) when
 * sandbox creds arrive — interface stays identical.
 */
export class MockICabbiAdapter implements PartnerAdapter {
  readonly key = "mock_icabbi";
  constructor(public readonly partnerId: string, private readonly tenantLabel: string) {}

  async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
    // simulate network latency
    await new Promise((r) => setTimeout(r, 50));
    // deterministic id so the smoke test can assert
    const externalId = `mock-icabbi-${this.tenantLabel}-${input.transitId.slice(0, 8)}`;
    console.log(
      `[MockICabbi:${this.tenantLabel}] createBooking transit=${input.transitId} ` +
        `externalId=${externalId} feeSnapshot=${JSON.stringify(input.feeSnapshot)}`,
    );
    return { externalId, acceptedAt: new Date().toISOString() };
  }

  async cancelBooking({ externalId, reason }: CancelBookingInput): Promise<void> {
    console.log(`[MockICabbi:${this.tenantLabel}] cancelBooking ${externalId} reason="${reason}"`);
  }

  async fetchBookingPayment(externalId: string): Promise<BookingPaymentSummary | null> {
    // Mock: synthesise a payment from the externalId so demo reconciliation
    // has something to compare against. We jitter by ±15% to make the drift
    // detection visible during demos (some bookings will exceed the 5%
    // threshold and get flagged).
    await new Promise((r) => setTimeout(r, 30));
    const seed = hashToFloat(externalId);
    const baseGbp = 5 + seed * 30; // £5–£35
    const jitter = (Math.random() - 0.5) * 0.3; // ±15%
    const totalPence = Math.round((baseGbp + baseGbp * jitter) * 100);
    return {
      totalPence,
      status: "PROCESSED",
      feePence: 20,
      processingFeePence: 0,
      fixedFare: seed > 0.5,
    };
  }

  async normaliseInboundWebhook(payload: Record<string, unknown>) {
    // Note: this is mock-specific. The real iCabbi adapter handles the full
    // shape catalogue (Karhoo envelope, direct booking object).
    // For the mock we accept two shapes:
    //   { type: "booking.network_send", booking: {...} } -> create
    //   { type: "booking.status_update", recipientBookingExternalId, status } -> status
    const t = payload.type as string | undefined;
    if (t === "booking.network_send") {
      const b = payload.booking as Record<string, unknown>;
      const booking: NormalisedBooking = {
        originatorBookingExternalId: String(b.id),
        bookingType: (b.bookingType as any) ?? "asap",
        channel: (b.channel as any) ?? "app",
        pickup: b.pickup as any,
        dropoff: b.dropoff as any,
        scheduledFor: b.scheduledFor as string | undefined,
        vehicleType: (b.vehicleType as string) ?? "standard",
        passengerCount: (b.passengerCount as number) ?? 1,
        fareEstimatePence: b.fareEstimatePence as number | undefined,
        passenger: b.passenger as any,
        notes: b.notes as string | undefined,
        raw: payload,
      };
      return { kind: "create" as const, booking };
    }
    if (t === "booking.status_update") {
      return {
        kind: "status" as const,
        recipientBookingExternalId: String(payload.recipientBookingExternalId),
        newStatus: String(payload.status),
        detail: payload,
      };
    }
    return null;
  }
}

// Deterministic [0,1) hash for the mock fee jitter
function hashToFloat(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
  return (Math.abs(h) % 1000) / 1000;
}
