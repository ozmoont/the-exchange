/**
 * Translation between iCabbi's inbound booking-offer shape and our
 * NormalisedBooking type. Used by /api/icabbi/bookings.
 *
 * The exact shape iCabbi sends isn't fully documented (item to confirm in
 * docs/ICABBI_DEPENDENCIES.md). Built against the BDD spec Section 1.3
 * canonical contract: { booking_id, pickup, dropoff, passenger, vehicle_type,
 * booking_type, scheduled_at, fare_estimate, currency }.
 *
 * We're tolerant of field-name variations (`bookingId` vs `booking_id`,
 * `vehicle_type` vs `vehicleType`) and provide explicit validation errors
 * pointing the caller at the missing field.
 */

import type { NormalisedBooking } from "@/lib/types";

export type ICabbiInboundBooking = {
  booking_id?: string;
  bookingId?: string;
  trip_id?: string;
  tripId?: string;
  booking_type?: string;
  bookingType?: string;
  scheduled_at?: string;
  scheduledAt?: string;
  pickup?: {
    lat?: number;
    lng?: number;
    longitude?: number;
    latitude?: number;
    address?: string;
    formatted?: string;
  };
  dropoff?: {
    lat?: number;
    lng?: number;
    longitude?: number;
    latitude?: number;
    address?: string;
    formatted?: string;
  };
  destination?: {
    lat?: number;
    lng?: number;
    longitude?: number;
    latitude?: number;
    address?: string;
    formatted?: string;
  };
  passenger?: {
    name?: string;
    phone?: string;
    count?: number;
  };
  passenger_count?: number;
  passengerCount?: number;
  customer_name?: string;
  customer_phone?: string;
  customer_mobile?: string;
  vehicle_type?: string;
  vehicleType?: string;
  fare_estimate?: number;
  fareEstimate?: number;
  currency?: string;
  instructions?: string;
  notes?: string;
  // Allow extra fields through into `raw` for audit.
  [key: string]: unknown;
};

export type NormaliseResult =
  | { ok: true; booking: NormalisedBooking; iCabbiBookingId: string }
  | { ok: false; status: 400; error: string; missingFields?: string[] };

/**
 * Translate iCabbi's inbound booking offer into our NormalisedBooking.
 *
 * Returns ok:false on missing required fields with a list of what's missing
 * so the caller's error response is actionable.
 */
/**
 * Map iCabbi-canonical vehicle types to our internal vehicleType strings.
 * Per STRATEGY.md decision #14 — translate canonical names at the wire
 * boundary, keep internal names as they are.
 *
 * Unknown values pass through unchanged so partner configs that use a
 * custom non-canonical name still match.
 */
function canonicalToInternalVehicleType(canonical: string): string {
  switch (canonical) {
    case "saloon":
      return "standard";
    case "exec":
    case "executive":
      return "exec";
    case "mpv":
    case "minivan":
      return "mpv";
    case "wav":
    case "wheelchair":
      return "wav";
    case "van":
      return "van";
    default:
      return canonical;
  }
}

export function normaliseICabbiInboundBooking(
  raw: ICabbiInboundBooking,
): NormaliseResult {
  const iCabbiBookingId = String(raw.booking_id ?? raw.bookingId ?? raw.trip_id ?? raw.tripId ?? "").trim();

  // Pickup / dropoff — tolerant of {lat,lng,address} or {latitude,longitude,formatted}.
  const pickup = raw.pickup ?? {};
  const dropoff = raw.dropoff ?? raw.destination ?? {};

  const pickupLat = Number(pickup.lat ?? pickup.latitude ?? NaN);
  const pickupLng = Number(pickup.lng ?? pickup.longitude ?? NaN);
  const pickupAddress = String(pickup.address ?? pickup.formatted ?? "").trim();
  const dropoffLat = Number(dropoff.lat ?? dropoff.latitude ?? NaN);
  const dropoffLng = Number(dropoff.lng ?? dropoff.longitude ?? NaN);
  const dropoffAddress = String(dropoff.address ?? dropoff.formatted ?? "").trim();

  const passengerName = String(raw.passenger?.name ?? raw.customer_name ?? "").trim();
  const passengerPhone = String(raw.passenger?.phone ?? raw.customer_phone ?? raw.customer_mobile ?? "").trim();
  const passengerCount = Number(raw.passenger?.count ?? raw.passenger_count ?? raw.passengerCount ?? 1);

  const bookingTypeRaw = String(raw.booking_type ?? raw.bookingType ?? "ASAP").toUpperCase();
  const bookingType: "asap" | "prebook" = bookingTypeRaw === "PREBOOK" ? "prebook" : "asap";

  const scheduledForRaw = raw.scheduled_at ?? raw.scheduledAt;
  const scheduledFor =
    typeof scheduledForRaw === "string" && scheduledForRaw.trim() ? scheduledForRaw.trim() : undefined;

  // Translate iCabbi canonical vehicle types (per BDD spec Section 4.1)
  // to our internal taxonomy. iCabbi canonical: saloon | exec | mpv | wav
  // | van. Our internal: standard | exec | wav | (and some custom).
  // Pass-through anything we don't recognise so future custom types still
  // route — they may still match a partner's exact-string vehicleTypes.
  const vehicleTypeRaw = String(raw.vehicle_type ?? raw.vehicleType ?? "standard").toLowerCase();
  const vehicleType = canonicalToInternalVehicleType(vehicleTypeRaw);
  const fareEstimate = raw.fare_estimate ?? raw.fareEstimate;
  const fareEstimatePence =
    typeof fareEstimate === "number" && Number.isFinite(fareEstimate)
      ? Math.round(fareEstimate * 100)
      : undefined;

  const missing: string[] = [];
  if (!iCabbiBookingId) missing.push("booking_id");
  if (!Number.isFinite(pickupLat) || pickupLat < -90 || pickupLat > 90) missing.push("pickup.lat");
  if (!Number.isFinite(pickupLng) || pickupLng < -180 || pickupLng > 180) missing.push("pickup.lng");
  if (!pickupAddress) missing.push("pickup.address");
  if (!Number.isFinite(dropoffLat) || dropoffLat < -90 || dropoffLat > 90) missing.push("dropoff.lat");
  if (!Number.isFinite(dropoffLng) || dropoffLng < -180 || dropoffLng > 180) missing.push("dropoff.lng");
  if (!dropoffAddress) missing.push("dropoff.address");
  if (!passengerName) missing.push("passenger.name");
  if (!passengerPhone) missing.push("passenger.phone");
  if (bookingType === "prebook" && !scheduledFor) missing.push("scheduled_at (required for PREBOOK)");

  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      error: "missing_or_invalid_fields",
      missingFields: missing,
    };
  }

  const booking: NormalisedBooking = {
    originatorBookingExternalId: iCabbiBookingId,
    bookingType,
    channel: "api",
    pickup: {
      lat: pickupLat,
      lng: pickupLng,
      address: pickupAddress,
    },
    dropoff: {
      lat: dropoffLat,
      lng: dropoffLng,
      address: dropoffAddress,
    },
    ...(scheduledFor ? { scheduledFor } : {}),
    vehicleType,
    passengerCount: Number.isFinite(passengerCount) && passengerCount > 0 ? passengerCount : 1,
    ...(fareEstimatePence != null ? { fareEstimatePence } : {}),
    passenger: {
      name: passengerName,
      phone: passengerPhone,
    },
    ...(typeof raw.instructions === "string" && raw.instructions.trim() ? { instructions: raw.instructions.trim() } : {}),
    ...(typeof raw.notes === "string" && raw.notes.trim() ? { notes: raw.notes.trim() } : {}),
    raw: {
      source: "icabbi-inbound",
      received_at: new Date().toISOString(),
      original: raw as Record<string, unknown>,
    },
  };

  return { ok: true, booking, iCabbiBookingId };
}
