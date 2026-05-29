import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  NormalisedBooking,
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

  async normaliseInboundWebhook(payload: Record<string, unknown>) {
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
