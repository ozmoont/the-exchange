import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
} from "@/lib/types";

/**
 * Mock CMAC adapter. CMAC is a corporate booking aggregator — it sends bookings
 * IN to the network rather than receiving most of the time. This mock supports
 * receiving bookings too so we can prove the route-out path works.
 */
export class MockCMACAdapter implements PartnerAdapter {
  readonly key = "mock_cmac";
  constructor(public readonly partnerId: string) {}

  async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
    await new Promise((r) => setTimeout(r, 80));
    const externalId = `mock-cmac-${input.transitId.slice(0, 8)}`;
    console.log(
      `[MockCMAC] createBooking transit=${input.transitId} externalId=${externalId} ` +
        `fee=${JSON.stringify(input.feeSnapshot)}`,
    );
    return { externalId, acceptedAt: new Date().toISOString() };
  }

  async cancelBooking({ externalId, reason }: CancelBookingInput): Promise<void> {
    console.log(`[MockCMAC] cancelBooking ${externalId} reason="${reason}"`);
  }

  async normaliseInboundWebhook(payload: Record<string, unknown>) {
    // CMAC pushes corporate bookings in a different shape; this is a minimal stub.
    const t = payload.type as string | undefined;
    if (t === "cmac.booking_request") {
      const b = payload.data as Record<string, unknown>;
      return {
        kind: "create" as const,
        booking: {
          originatorBookingExternalId: String(b.reference),
          bookingType: "prebook" as const,
          channel: "api" as const,
          pickup: b.pickup as any,
          dropoff: b.dropoff as any,
          scheduledFor: b.scheduledFor as string,
          vehicleType: (b.vehicleType as string) ?? "executive",
          passengerCount: (b.pax as number) ?? 1,
          fareEstimatePence: b.fareEstimatePence as number | undefined,
          passenger: b.traveller as any,
          notes: b.notes as string | undefined,
          raw: payload,
        },
      };
    }
    if (t === "cmac.status_update") {
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
