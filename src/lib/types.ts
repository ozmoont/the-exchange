import type { FeeSnapshot } from "@/db/schema";

/**
 * The neutral booking shape the middleware passes between adapters.
 * Adapters translate to/from this format. iCabbi-shaped and CMAC-shaped
 * payloads both arrive normalised as a `NormalisedBooking`.
 */
export type NormalisedBooking = {
  // From the originator
  originatorBookingExternalId: string;
  bookingType: "asap" | "prebook";
  channel: "app" | "web" | "phone" | "api";

  pickup: { lat: number; lng: number; address: string; postcode?: string };
  dropoff: { lat: number; lng: number; address: string; postcode?: string };

  scheduledFor?: string; // ISO timestamp, set for prebook
  vehicleType: string;
  passengerCount: number;
  fareEstimatePence?: number;

  passenger: {
    name: string;
    phone: string;
    // PII minimisation: only what the receiver needs to fulfil
  };

  notes?: string;
  // raw originator payload retained for audit; receivers may opt in to specific fields
  raw: Record<string, unknown>;
};

export type CreateBookingInput = {
  transitId: string;
  recipientPartnerId: string;
  booking: NormalisedBooking;
  feeSnapshot: FeeSnapshot;
};

export type CreateBookingResult = {
  externalId: string;
  acceptedAt: string; // ISO
};

export type CancelBookingInput = {
  externalId: string;
  reason: string;
};

/**
 * Every partner integration implements this. iCabbiAdapter handles a single
 * iCabbi tenant. CMACAdapter handles CMAC. Mock implementations under
 * src/adapters/mock-* support local dev and the smoke test.
 */
export interface PartnerAdapter {
  readonly key: string; // matches partners.adapterKey
  readonly partnerId: string;

  createBooking(input: CreateBookingInput): Promise<CreateBookingResult>;
  cancelBooking(input: CancelBookingInput): Promise<void>;

  /**
   * Translate a partner-shaped inbound webhook payload into a NormalisedBooking
   * (for "external partner sends booking IN" flows) or into a transit status
   * update. Adapters that don't accept inbound work return null.
   */
  normaliseInboundWebhook(
    payload: Record<string, unknown>,
  ): Promise<
    | { kind: "create"; booking: NormalisedBooking }
    | { kind: "status"; recipientBookingExternalId: string; newStatus: string; detail?: Record<string, unknown> }
    | null
  >;
}
