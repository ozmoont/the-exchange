import type { FeeSnapshot } from "@/db/schema";

/**
 * The neutral booking shape the middleware passes between adapters.
 * Adapters translate to/from this format. iCabbi-shaped and CMAC-shaped
 * payloads both arrive normalised as a `NormalisedBooking`.
 *
 * Fields are organised in three layers:
 *   1. Core — every adapter must populate (pickup, dropoff, passenger, etc.)
 *   2. Operational — most adapters populate (vehicle type, payment, notes)
 *   3. iCabbi-rich — only populated by adapters that have the data (vias,
 *      attribute groups, tariff ids, etc.). Other adapters leave them
 *      undefined; the routing engine falls back to defaults.
 *
 * Backward compatible — every new field is optional or has a default-friendly
 * shape so old callers (seed.ts, mock adapter, fire-jobs script) keep working.
 */
export type NormalisedBooking = {
  // ---------- Core (every adapter populates) ----------
  originatorBookingExternalId: string;
  bookingType: "asap" | "prebook";
  channel: "app" | "web" | "phone" | "api";

  pickup: BookingPoint;
  dropoff: BookingPoint;

  scheduledFor?: string; // ISO timestamp, set for prebook
  vehicleType: string;   // our taxonomy: "standard" | "exec" | "wav" | …
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

  // ---------- Operational (most adapters populate) ----------

  /** Driver-facing instructions ("ring buzzer 3", "back gate"). */
  instructions?: string;
  /** Dispatcher-facing comment ("VIP", "regular"). Not shown to driver. */
  driverComment?: string;
  /** Payment method on the originating side. Affects fee + reconciliation. */
  paymentType?: "cash" | "card" | "account" | "voucher";
  /** Source channel as reported by the originator (APP, DISPATCH, etc.). Informational. */
  source?: string;
  /** Flight number for airport pickups. */
  flightNumber?: string;
  /** Flight number for airport dropoffs. */
  destinationFlightNumber?: string;

  // ---------- iCabbi-rich (only populated by adapters that have it) ----------

  /**
   * Intermediate pickup / dropoff points. Single-stop bookings have vias = [].
   * Adapters that don't support multi-stop leave this undefined.
   *
   *   pickup → vias[0] → vias[1] → ... → dropoff
   */
  vias?: BookingPoint[];

  /**
   * Native vehicle code in the originator's taxonomy (e.g. iCabbi "R4").
   * Used by the recipient adapter when re-creating the booking on the other side.
   */
  nativeVehicleType?: string;
  /** Native vehicle group ("Taxi", "Executive", "MPV"). */
  vehicleGroup?: string;
  /**
   * Compliance / accessibility flag bundle — child seat, WAV, etc. Routing
   * engine must honour these when matching candidates. Adapter-specific id.
   */
  attributeGroupId?: string;
  /** Corporate account id when the booking is on-account. */
  accountId?: string;
  /** Originator-side tariff id (for fare reconciliation). */
  tariffId?: string;
  /** Whether the originator used a fixed-fare quote. */
  fixedFare?: boolean;
  /** Originator-side operating zone (sub-region). */
  zoneId?: string;
  /** Originator-side priority indicator. Higher = more urgent. */
  priority?: number;
};

export type BookingPoint = {
  lat: number;
  lng: number;
  address: string;
  postcode?: string;
  /** Name of the passenger at this stop (for multi-passenger via routes). */
  contactName?: string;
  /** Phone at this stop. */
  contactPhone?: string;
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
  /**
   * Cross-tenant linkage populated when the recipient is on iCabbi and the
   * coid partnership mechanism carried the booking. Stored on the transit so
   * we can reconcile both sides later.
   */
  partnership?: {
    coid?: string;
    clientId?: string;
    serverName?: string;
    siteId?: string;
  };
  /** Passenger tracking URL exposed by the recipient, if any. */
  trackMyTaxiLink?: string;
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

  /**
   * Optional. Fetch the partner's final billed totals for a completed
   * booking, used by the reconciliation engine to compare against our
   * feeSnapshot. Adapters that can't easily fetch this (e.g. webhook-only
   * partners) leave it undefined.
   *
   * Returns pence, never decimal — caller is responsible for currency
   * conversion if mixing GBP/EUR.
   */
  fetchBookingPayment?(externalId: string): Promise<BookingPaymentSummary | null>;
}

export type BookingPaymentSummary = {
  /** What the partner billed in total for this booking, in pence. */
  totalPence: number;
  /** Their internal payment status ('PROCESSED', 'NEW', etc.) — informational. */
  status?: string;
  /** Fee surfaced separately (e.g. iCabbi's 'fee' field). */
  feePence?: number;
  /** Processing fee surfaced separately (e.g. iCabbi's 'processing_fee'). */
  processingFeePence?: number;
  /** Whether this was a fixed-price booking. */
  fixedFare?: boolean;
  /** Tariff id if relevant. */
  tariffId?: string;
};
