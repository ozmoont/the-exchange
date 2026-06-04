import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  NormalisedBooking,
  BookingPoint,
} from "@/lib/types";
import { mapICabbiStatus, isIgnoredICabbiStatus } from "@/lib/icabbi-status-map";

/**
 * Real iCabbi adapter.
 *
 * Built against the iCabbi v2 API spec (Swagger 2.0). Key facts:
 *
 *   - Single global host: https://api.icabbi.com/v2 (overridable via env).
 *     A tenant is identified by its App-Key/Secret-Key pair, not by URL.
 *   - Auth: two headers on every request — `App-Key` and `Secret-Key`.
 *     There is no OAuth in this API. No tokens, no expiry, no caching.
 *   - Booking create: POST /bookings/add with a BookingSimpleCreate body:
 *       { date?, name, phone, address: PickupRequest, destination: DestinationRequest }
 *     PickupRequest / DestinationRequest = { lat, lng, formatted }
 *   - Cancel: POST /bookings/cancel/{trip_id}
 *   - Status update: POST /bookings/status_update (body: { trip_id, status })
 *   - Generic response envelope: { version, code, body, warnings, nonce }
 *     Real payload is in `body`. Non-2xx responses use the same envelope
 *     with a non-success `code`.
 *
 * Webhook receipt (iCabbi pushing into us when a trip is marked for the
 * network) is NOT in this file. That happens at the route-handler layer;
 * this adapter's normaliseInboundWebhook only knows how to translate the
 * payload shape once it arrives. The webhook-out side from iCabbi isn't
 * documented in their Swagger explorer — confirm with iCabbi what events
 * they emit and adjust `parseInboundEvent` below when you know.
 *
 * KNOWN ASSUMPTIONS still to verify with a live tenant:
 *   - The shape of the body returned inside the Response envelope on
 *     /bookings/add. Spec doesn't pin it down. We try `id`, `trip_id`, and
 *     `booking.id` in that order.
 *   - The shape of inbound webhook events. Currently stubbed — needs
 *     real samples from iCabbi to confirm event names and payload layout.
 */

const DEFAULT_BASE = "https://api.icabbi.com/v2";

export type ICabbiCredentials = {
  appKey: string;
  secretKey: string;
  /**
   * Secret WE generate when this partner is connected. iCabbi configures
   * their outbound webhook to sign payloads to The Exchange with this
   * secret. Verified at the route-handler layer, not here.
   */
  webhookSecret: string;
  /**
   * If we successfully auto-registered our webhook URL with iCabbi at
   * connect time, this holds the subscription_id they returned. Used to
   * DELETE the subscription on disconnect.
   */
  webhookSubscriptionId?: string;
};

/**
 * Standalone helpers (no class instance needed) so the admin credential
 * save action can call them right after writing credentials, without
 * having to construct an adapter.
 */

export type RegisterWebhookArgs = {
  appKey: string;
  secretKey: string;
  url: string;
  sharedSecret: string;
  topics?: string[];
};

export type RegisterWebhookResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; status: number; message: string };

const DEFAULT_TOPICS = ["TripStatus", "DriverDetails", "FinalFareReleased"] as const;

export async function registerWebhookSubscription(
  args: RegisterWebhookArgs,
): Promise<RegisterWebhookResult> {
  const base = (process.env.ICABBI_API_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const body = {
    url: args.url,
    shared_secret: args.sharedSecret,
    topics: args.topics ?? DEFAULT_TOPICS,
  };

  try {
    const res = await fetch(`${base}/webhooks/register`, {
      method: "POST",
      headers: {
        "App-Key": args.appKey,
        "Secret-Key": args.secretKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, message: text.slice(0, 300) };
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }
    const envelope = json as { body?: { subscription_id?: string; id?: string } } | null;
    const subId =
      envelope?.body?.subscription_id ??
      envelope?.body?.id ??
      (json as { subscription_id?: string } | null)?.subscription_id ??
      "";
    if (!subId) {
      return { ok: false, status: 200, message: `no subscription id in response: ${text.slice(0, 200)}` };
    }
    return { ok: true, subscriptionId: String(subId) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: msg };
  }
}

export async function deleteWebhookSubscription(args: {
  appKey: string;
  secretKey: string;
  subscriptionId: string;
}): Promise<{ ok: boolean; status: number; message?: string }> {
  const base = (process.env.ICABBI_API_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  try {
    const res = await fetch(
      `${base}/webhooks/${encodeURIComponent(args.subscriptionId)}`,
      {
        method: "DELETE",
        headers: {
          "App-Key": args.appKey,
          "Secret-Key": args.secretKey,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, message: text.slice(0, 300) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: msg };
  }
}

export class ICabbiAdapter implements PartnerAdapter {
  readonly key = "icabbi";

  constructor(
    public readonly partnerId: string,
    private readonly creds: ICabbiCredentials,
  ) {
    if (!creds.appKey || !creds.secretKey) {
      throw new Error(
        `ICabbiAdapter ${partnerId} missing credentials. Expected { appKey, secretKey, webhookSecret }.`,
      );
    }
  }

  async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
    const body = buildBookingSimpleCreate(input.booking);
    const envelope = await this.post<ICabbiResponseEnvelope>("/bookings/add", body);

    const externalId = extractBookingId(envelope.body);
    if (!externalId) {
      throw new Error(
        `iCabbi createBooking returned no id (code=${envelope.code}, body=${JSON.stringify(envelope.body).slice(0, 200)})`,
      );
    }

    // If iCabbi's response includes a partnership_booking block, this booking
    // is being carried over their coid partnership protocol (Position #2).
    // Capture the linkage so we can reconcile both sides later.
    const partnership = extractPartnershipLinkage(envelope.body);
    const trackLink = extractTrackMyTaxiLink(envelope.body);

    return {
      externalId,
      acceptedAt: new Date().toISOString(),
      ...(partnership ? { partnership } : {}),
      ...(trackLink ? { trackMyTaxiLink: trackLink } : {}),
    };
  }

  async cancelBooking({ externalId, reason }: CancelBookingInput): Promise<void> {
    const path = `/bookings/cancel/${encodeURIComponent(externalId)}`;
    // The spec only documents the path parameter; we send the reason in the
    // body in case iCabbi accepts it for the audit trail. If they ignore it,
    // no harm.
    await this.post(path, { reason });
  }

  async normaliseInboundWebhook(payload: Record<string, unknown>) {
    return parseInboundEvent(payload);
  }

  // ---------- internals ----------

  private baseUrl(): string {
    return (process.env.ICABBI_API_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  }

  private headers(): HeadersInit {
    return {
      "App-Key": this.creds.appKey,
      "Secret-Key": this.creds.secretKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async post<T = ICabbiResponseEnvelope>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      throw new Error(
        `iCabbi POST ${path} failed: ${res.status} ${text.slice(0, 300)}`,
      );
    }
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function buildBookingSimpleCreate(b: NormalisedBooking): Record<string, unknown> {
  // BookingSimpleCreate per Swagger:
  //   date?: ISO-8601 (omitted for ASAP)
  //   name: string
  //   phone: string (E.164)
  //   address: PickupRequest { lat, lng, formatted }
  //   destination: DestinationRequest { lat, lng, formatted }
  const body: Record<string, unknown> = {
    name: b.passenger.name,
    phone: b.passenger.phone,
    address: {
      lat: b.pickup.lat,
      lng: b.pickup.lng,
      formatted: b.pickup.address,
    },
    destination: {
      lat: b.dropoff.lat,
      lng: b.dropoff.lng,
      formatted: b.dropoff.address,
    },
  };

  // ASAP omits date. Prebook sends ISO-8601.
  if (b.bookingType === "prebook" && b.scheduledFor) {
    body.date = b.scheduledFor;
  }

  // External reference — iCabbi's SimpleCreate doesn't formally accept this,
  // but most dispatch systems tolerate unknown fields. If we find out iCabbi
  // rejects unknown keys, move this into bookingsAddComplex.
  body.external_reference = b.originatorBookingExternalId;

  return body;
}

// ---------------------------------------------------------------------------
// Response unwrapping
// ---------------------------------------------------------------------------

type ICabbiResponseEnvelope = {
  version: string;
  code: number | string;
  body: unknown;
  warnings?: unknown[];
  nonce?: string;
};

function extractBookingId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Try the common field names iCabbi uses across endpoints. perma_id is the
  // STABLE id across re-dispatches — prefer it where present so we don't treat
  // a re-dispatched job as a new booking.
  for (const key of ["perma_id", "trip_id", "tripId", "booking_id", "bookingId", "id"]) {
    const v = b[key];
    if (v != null && (typeof v === "string" || typeof v === "number")) {
      return String(v);
    }
  }

  // Nested under "booking" — same priority order
  const nested = b.booking;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    for (const key of ["perma_id", "trip_id", "tripId", "booking_id", "bookingId", "id"]) {
      const v = n[key];
      if (v != null && (typeof v === "string" || typeof v === "number")) {
        return String(v);
      }
    }
  }

  return null;
}

/**
 * Pull the partnership coid linkage out of a real iCabbi booking response.
 * Present on the demand-side view of cross-tenant bookings. Returns undefined
 * when the field isn't there (intra-tenant booking, or first-time direct
 * dispatch with no partner).
 */
function extractPartnershipLinkage(body: unknown):
  | { coid?: string; clientId?: string; serverName?: string; siteId?: string }
  | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const booking = (root.booking ?? root) as Record<string, unknown>;
  const pb = booking.partnership_booking as Record<string, unknown> | undefined;
  if (!pb) return undefined;

  const out: { coid?: string; clientId?: string; serverName?: string; siteId?: string } = {};
  if (pb.coid != null) out.coid = String(pb.coid);
  if (pb.client_id != null) out.clientId = String(pb.client_id);
  if (pb.server_name != null) out.serverName = String(pb.server_name);
  if (pb.site_id != null) out.siteId = String(pb.site_id);
  return Object.keys(out).length ? out : undefined;
}

function extractTrackMyTaxiLink(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const booking = (root.booking ?? root) as Record<string, unknown>;
  const pb = booking.partnership_booking as Record<string, unknown> | undefined;
  const link = pb?.track_my_taxi_link ?? booking.track_my_taxi_link;
  return typeof link === "string" && link ? link : undefined;
}

// ---------------------------------------------------------------------------
// Inbound webhook normalisation
// ---------------------------------------------------------------------------

/**
 * Translate an inbound iCabbi webhook event to our internal shape.
 *
 * The envelope (same as Karhoo, since iCabbi owns Karhoo):
 *   {
 *     id: string,                  // event id, used for idempotency
 *     event_type: "TripStatus" | "DriverDetails" | "FinalFareReleased" | "DriverPositionChanged",
 *     sent_at: ISO 8601,
 *     checksum: string,            // sha512 of `data`
 *     attempt_number: number,
 *     data: string                 // STRINGIFIED JSON — must JSON.parse()
 *   }
 *
 * data shapes vary by event_type. We handle:
 *   - TripStatus  → status update on an existing transit
 *   - DriverDetails → driver_assigned status update with driver+vehicle in detail
 *
 * We currently SKIP:
 *   - FinalFareReleased — billing event, not a lifecycle change. Hook this up
 *     when we wire the settlement ledger.
 *   - DriverPositionChanged — too noisy for our purposes. Add when we expose
 *     a live-tracking view.
 *
 * NOTE: there is no "booking created" / "trip created" event in iCabbi's
 * documented webhook set. The mechanism by which a fleet marks a trip for
 * the network and it reaches our /api/webhooks/ingest/<partner> URL is
 * still TBD — confirm with iCabbi. The path below for `kind: "create"` is
 * speculative until we know what they actually emit.
 */

/**
 * Map Karhoo-shaped TripStatus values (REQUESTED, CONFIRMED, DRIVER_EN_ROUTE, …)
 * to our internal transit status. This is distinct from the direct-iCabbi
 * status map in `src/lib/icabbi-status-map.ts` because Karhoo uses a different
 * vocabulary (CONFIRMED vs ASSIGNED, POB is shared, etc.) and is sent through
 * a separate webhook envelope.
 */
function mapKarhooTripStatus(karhooStatus: string): string {
  switch (karhooStatus.toUpperCase()) {
    case "REQUESTED":      // deprecated upstream
      return "pushed";
    case "CONFIRMED":
      return "accepted";
    case "ARRIVED":
      return "driver_arrived";
    case "DRIVER_EN_ROUTE":
      return "en_route";
    case "POB":
      return "on_board";
    case "COMPLETED":
      return "completed";
    case "DRIVER_CANCELLED":
    case "BOOKER_CANCELLED":
    case "KARHOO_CANCELLED":
      return "cancelled";
    case "NO_DRIVERS_AVAILABLE":
    case "FAILED":
      return "failed";
    default:
      return "error_other";
  }
}

async function parseInboundEvent(
  payload: Record<string, unknown>,
): Promise<
  | { kind: "create"; booking: NormalisedBooking }
  | { kind: "status"; recipientBookingExternalId: string; newStatus: string; detail?: Record<string, unknown> }
  | null
> {
  // ------------------------------------------------------------------------
  // Shape detection. iCabbi's webhook payloads come in two distinct shapes:
  //
  //   1. Karhoo-style envelope: { id, event_type, sent_at, checksum, data }
  //      where `data` is a STRINGIFIED JSON blob whose contents depend on
  //      event_type. This is what iCabbi-as-Karhoo demand aggregator uses.
  //
  //   2. Direct iCabbi v2 booking object: { version, code, body: { booking } }
  //      — what their direct partnership API returns. Used for new-booking
  //      events delivered over iCabbi's coid partnership protocol.
  //
  // We sniff the shape before deciding how to parse. Direct-booking shape
  // takes precedence because it carries the richer field set.
  // ------------------------------------------------------------------------

  const direct = extractDirectICabbiBooking(payload);
  if (direct) {
    return await parseDirectICabbiPayload(direct);
  }

  const eventType = String(payload.event_type ?? payload.event ?? payload.type ?? "");

  // Decode the `data` field (stringified JSON) into a usable object
  let data: Record<string, unknown> = {};
  const rawData = payload.data;
  if (typeof rawData === "string") {
    try {
      data = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (rawData && typeof rawData === "object") {
    // Some flows might send `data` already as an object — handle both
    data = rawData as Record<string, unknown>;
  }

  switch (eventType) {
    case "TripStatus": {
      const tripId = String(data.trip_id ?? "");
      const status = String(data.status ?? "");
      if (!tripId || !status) return null;
      return {
        kind: "status",
        recipientBookingExternalId: tripId,
        newStatus: mapKarhooTripStatus(status),
        detail: {
          karhoo_status: status,
          state_details: data.state_details ?? null,
          envelope_id: payload.id,
          sent_at: payload.sent_at,
        },
      };
    }

    case "DriverDetails": {
      const tripId = String(data.trip_id ?? "");
      if (!tripId) return null;
      return {
        kind: "status",
        recipientBookingExternalId: tripId,
        newStatus: "driver_assigned",
        detail: {
          driver: data.driver,
          description: data.description,
          vehicle_class: data.vehicle_class,
          vehicle_license_plate: data.vehicle_license_plate,
          make: data.make,
          model: data.model,
          colour: data.colour,
          passenger_capacity: data.passenger_capacity,
          luggage_capacity: data.luggage_capacity,
          tags: data.tags,
          envelope_id: payload.id,
          sent_at: payload.sent_at,
        },
      };
    }

    case "FinalFareReleased":
      // Billing event — not a lifecycle change. Returning null = "ack but no
      // transit state change". Settlement integration will pick this up
      // separately when wired.
      return null;

    case "DriverPositionChanged":
      // Skip — too high-frequency for our current model.
      return null;

    default:
      // Unknown event type. Returning null lets the route handler 200-ack
      // (so iCabbi doesn't retry forever) while logging the unknown shape.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Direct iCabbi v2 booking-object normalisation
// ---------------------------------------------------------------------------
//
// When iCabbi delivers a partnership-booking event directly (Position #2 path)
// the payload is shaped like:
//
//   { version, code, body: { booking: { id, address, destination, ... } } }
//
// or sometimes just the inner booking object. The helpers below extract that
// inner object, decide whether it's a CREATE or a STATUS event, and produce
// either a NormalisedBooking or a status-update record.

/**
 * Detect a direct iCabbi v2 booking shape. Returns the inner `booking` object
 * if present, or null if the payload doesn't look like one.
 */
function extractDirectICabbiBooking(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  // Direct API response envelope: { body: { booking: { ... } } }
  const body = payload.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object") {
    const booking = body.booking;
    if (booking && typeof booking === "object" && isLikelyBooking(booking as Record<string, unknown>)) {
      return booking as Record<string, unknown>;
    }
  }
  // Or the payload itself may be the booking object
  if (isLikelyBooking(payload)) {
    return payload;
  }
  // Some webhook envelopes wrap the booking under `data` without stringifying
  const data = payload.data;
  if (data && typeof data === "object" && isLikelyBooking(data as Record<string, unknown>)) {
    return data as Record<string, unknown>;
  }
  return null;
}

/** Heuristic: a direct iCabbi booking always carries `address` + `destination` + `status`. */
function isLikelyBooking(obj: Record<string, unknown>): boolean {
  return (
    obj.address != null &&
    obj.destination != null &&
    typeof obj.status === "string"
  );
}

async function parseDirectICabbiPayload(
  booking: Record<string, unknown>,
): Promise<
  | { kind: "create"; booking: NormalisedBooking }
  | { kind: "status"; recipientBookingExternalId: string; newStatus: string; detail?: Record<string, unknown> }
  | null
> {
  const status = String(booking.status ?? "");

  // If the booking has a meaningful current status that maps to a transit
  // status, treat it as a status update on an existing transit. The
  // recipientBookingExternalId is the stable perma_id (falls back to
  // booking_id / id).
  const mapped = mapICabbiStatus(status);
  if (mapped) {
    const ext =
      String(booking.perma_id ?? booking.booking_id ?? booking.trip_id ?? booking.id ?? "");
    if (!ext) return null;

    return {
      kind: "status",
      recipientBookingExternalId: ext,
      newStatus: mapped,
      detail: {
        icabbi_status: status,
        // Include driver/vehicle info ONLY when this event represents a
        // driver-related lifecycle change. UI panel pulls from this.
        ...(mapped === "driver_assigned" || mapped === "driver_arrived"
          ? { driver: extractDriverDetail(booking) }
          : {}),
        partnership: extractPartnershipLinkage(booking),
      },
    };
  }

  if (isIgnoredICabbiStatus(status)) {
    // Known meta-state we deliberately ignore.
    return null;
  }

  // Otherwise treat this as a new booking arriving for routing.
  const normalised = normaliseICabbiBookingObject(booking);
  if (!normalised) return null;
  return { kind: "create", booking: normalised };
}

/** Map an iCabbi booking object to our NormalisedBooking. */
function normaliseICabbiBookingObject(
  booking: Record<string, unknown>,
): NormalisedBooking | null {
  const pickup = toPoint(booking.address, asString(booking.name), asString(booking.phone));
  const dropoff = toPoint(booking.destination);
  if (!pickup || !dropoff) return null;

  // perma_id is the stable id across re-dispatches; prefer it.
  const externalId =
    asString(booking.perma_id) ??
    asString(booking.booking_id) ??
    asString(booking.trip_id) ??
    asString(booking.id) ??
    "";
  if (!externalId) return null;

  // vias[] in iCabbi includes the pickup itself with type='PICKUP' — strip
  // those out so we keep only intermediate stops.
  const vias: BookingPoint[] = [];
  const rawVias = booking.vias;
  if (Array.isArray(rawVias)) {
    for (const v of rawVias) {
      if (!v || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      // The first entry is usually the pickup itself; we already capture it
      const type = asString(r.type);
      if (type && type.toUpperCase() === "PICKUP") continue;
      const point = toPoint(r, asString(r.name), asString(r.phone));
      if (point) vias.push(point);
    }
  }

  const prebooked = Number(booking.prebooked ?? 0) === 1;
  const scheduledFor = asString(booking.pickup_date) ?? asString(booking.date);

  const payment = (booking.payment ?? {}) as Record<string, unknown>;
  const route = (booking.route ?? {}) as Record<string, unknown>;
  const zone = (booking.zone ?? {}) as Record<string, unknown>;

  const passengerCount = Number(payment.passengers ?? 1) || 1;
  const fareEstimateGbp = Number(payment.cost ?? route.estimate_fare ?? 0) || 0;

  const nativeVehicleType = asString(booking.vehicle_type) ?? undefined;
  const vehicleGroup = asString(booking.vehicle_group) ?? undefined;

  return {
    originatorBookingExternalId: externalId,
    bookingType: prebooked ? "prebook" : "asap",
    channel: mapChannel(asString(booking.source)),
    pickup,
    dropoff,
    scheduledFor: prebooked ? scheduledFor ?? undefined : undefined,
    vehicleType: mapNativeVehicleType(nativeVehicleType, vehicleGroup),
    passengerCount,
    fareEstimatePence: Math.round(fareEstimateGbp * 100) || undefined,
    passenger: {
      name: asString(booking.name) ?? "",
      phone: asString(booking.phone) ?? "",
    },
    notes: asString(booking.notes) ?? undefined,
    instructions: asString(booking.instructions) ?? undefined,
    driverComment: asString(booking.driver_comment) ?? undefined,
    paymentType: mapPaymentType(asString(booking.payment_type)),
    source: asString(booking.source) ?? undefined,
    flightNumber: asString(booking.flight_number) ?? undefined,
    destinationFlightNumber: asString(booking.destination_flight_number) ?? undefined,
    vias,
    nativeVehicleType,
    vehicleGroup,
    attributeGroupId: asString(booking.attributegroup_id) ?? undefined,
    accountId:
      booking.account_id != null && Number(booking.account_id) > 0
        ? String(booking.account_id)
        : undefined,
    tariffId: asString(payment.tariff_id) ?? undefined,
    fixedFare: Number(payment.fixed ?? 0) === 1,
    zoneId: asString(zone.ref) ?? asString(booking.zone_id) ?? undefined,
    priority: Number(booking.priority ?? 0) || undefined,
    raw: booking,
  };
}

function toPoint(
  raw: unknown,
  contactName?: string,
  contactPhone?: string,
): BookingPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat ?? r.actual_lat ?? NaN);
  const lng = Number(r.lng ?? r.actual_lng ?? NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    address: asString(r.formatted) ?? "",
    postcode: asString(r.postcode) ?? undefined,
    contactName: contactName ?? undefined,
    contactPhone: contactPhone ?? undefined,
  };
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * Map iCabbi's native vehicle codes / groups to our taxonomy. Best-effort —
 * the `nativeVehicleType` field on NormalisedBooking preserves the original
 * code so adapter-side accuracy isn't lost.
 */
function mapNativeVehicleType(
  vehicleType: string | undefined,
  vehicleGroup: string | undefined,
): string {
  const group = vehicleGroup?.toLowerCase() ?? "";
  if (group.includes("exec")) return "exec";
  if (group.includes("wav") || group.includes("wheelchair")) return "wav";
  if (group.includes("mpv") || group.includes("6") || group.includes("7") || group.includes("8")) return "mpv";

  // Fall back to iCabbi codes: R4 = 4-seater regular, R7 = 7-seater, etc.
  if (vehicleType) {
    const code = vehicleType.toUpperCase();
    if (code.startsWith("R") && code.length >= 2) {
      const seats = Number(code.slice(1));
      if (Number.isFinite(seats)) {
        if (seats >= 7) return "mpv";
        return "standard";
      }
    }
    if (code.includes("EXEC")) return "exec";
    if (code.includes("WAV")) return "wav";
  }
  return "standard";
}

function mapPaymentType(raw: string | undefined): "cash" | "card" | "account" | "voucher" | undefined {
  if (!raw) return undefined;
  const v = raw.toUpperCase();
  if (v === "CASH") return "cash";
  if (v === "CARD" || v === "CREDIT_CARD") return "card";
  if (v === "ACCOUNT" || v === "INVOICE") return "account";
  if (v === "VOUCHER") return "voucher";
  return undefined;
}

function mapChannel(source: string | undefined): "app" | "web" | "phone" | "api" {
  switch (source?.toUpperCase()) {
    case "APP":
      return "app";
    case "WEB":
      return "web";
    case "PHONE":
    case "PHONE_CALL":
      return "phone";
    case "DISPATCH":
    case "API":
    default:
      return "api";
  }
}

function extractDriverDetail(booking: Record<string, unknown>): Record<string, unknown> | undefined {
  const driver = booking.driver as Record<string, unknown> | undefined;
  if (!driver || !driver.first_name) return undefined;
  const vehicle = (driver.vehicle ?? {}) as Record<string, unknown>;
  return {
    first_name: driver.first_name,
    last_name: driver.last_name,
    phone_number: driver.mobile ?? driver.phone,
    // We deliberately DO NOT pass through: address, NI, licence, PSV, photo
    // (those stay on the recipient side). See driverDetailsRequired toggle —
    // the route handler enforces this; the adapter just exposes the fields.
    make: vehicle.make,
    model: vehicle.model,
    colour: vehicle.colour,
    reg: vehicle.reg ?? vehicle.plate,
  };
}
