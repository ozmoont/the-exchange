import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  NormalisedBooking,
} from "@/lib/types";

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

    return {
      externalId,
      acceptedAt: new Date().toISOString(),
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

  // Try the common field names iCabbi uses across endpoints
  for (const key of ["trip_id", "tripId", "id", "booking_id", "bookingId"]) {
    const v = b[key];
    if (v != null && (typeof v === "string" || typeof v === "number")) {
      return String(v);
    }
  }

  // Nested under "booking"
  const nested = b.booking;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    for (const key of ["trip_id", "tripId", "id"]) {
      const v = n[key];
      if (v != null && (typeof v === "string" || typeof v === "number")) {
        return String(v);
      }
    }
  }

  return null;
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

/** Map Karhoo / iCabbi TripStatus values to our internal transit status. */
function mapTripStatus(karhooStatus: string): string {
  switch (karhooStatus.toUpperCase()) {
    case "REQUESTED":      // deprecated upstream
      return "pushed";
    case "CONFIRMED":
      return "accepted";
    case "DRIVER_EN_ROUTE":
    case "ARRIVED":        // driver at pickup; treat as en_route until POB
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
        newStatus: mapTripStatus(status),
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
