import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  NormalisedBooking,
  BookingPoint,
  BookingPaymentSummary,
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

/**
 * Resolve the API base URL for an iCabbi call. Per-partner override wins
 * over the env-global override, which wins over the production default.
 *
 * This matters because different iCabbi tenants live on different clusters
 * (e.g. "1staging" sandbox cluster at https://1stagingapi.icabbi.com/1staging,
 * "bounds" production cluster). One global env var can't serve them all once
 * we have more than one partner. Per-partner config does.
 */
function resolveBaseUrl(override?: string | null): string {
  const url = override ?? process.env.ICABBI_API_BASE_URL ?? DEFAULT_BASE;
  return url.replace(/\/$/, "");
}

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
   * Per-partner API base URL override. Required for sandbox/staging tenants
   * that aren't on the production host. Examples:
   *   - "https://1stagingapi.icabbi.com/1staging" (Staging 1)
   *   - "https://api.icabbi.com/v2" (production, the default)
   * Omit to use the env-global / production default.
   */
  apiBaseUrl?: string;
  /**
   * iCabbi listener ids returned from /eventlisteners/create — one per
   * subscribed event. Persisted so we can delete them on disconnect or
   * re-register (delete-all-then-create-all pattern in
   * resetWebhookListeners). iCabbi's list endpoint returns 401 for our
   * key, so we cannot reconcile from source.
   */
  webhookListeners?: WebhookListenerRecord[];
  /**
   * @deprecated legacy single-id field from the pre-eventlisteners
   * registration scheme. Read-only — only consulted during disconnect
   * cleanup for partners onboarded before the rewrite, and cleared
   * once they reconnect under the new shape.
   */
  webhookSubscriptionId?: string;
};

/**
 * iCabbi webhook subscription helpers — standalone (no class instance
 * needed) so the integration page can call them right after writing
 * credentials.
 *
 * The real iCabbi protocol (confirmed against staging):
 *   - POST {base}/eventlisteners/create — one per event, body
 *     { name, event, url, format: "json", template: "#json" }.
 *     Response: { eventlistener: { id: number, ... } }
 *   - POST {base}/eventlisteners/delete/{id}
 *
 * iCabbi cannot sign outbound webhooks. The shared-secret goes in the
 * URL as `?token=<secret>` instead — the inbound route at
 * /api/webhooks/ingest/[partnerId] handles that path. See task #238.
 *
 * We can't read iCabbi's list endpoint (401 for our key), so listener
 * ids must be persisted on our side. `resetWebhookListeners` returns
 * the full array of created listeners which the caller writes back to
 * partners.credentials.webhookListeners.
 */

import {
  ICABBI_WEBHOOK_EVENTS,
  buildListenerName,
  type IcabbiWebhookEvent,
} from "@/lib/icabbi-webhook-events";

export type WebhookListenerRecord = {
  /** iCabbi's eventlistener.id — what we POST to /eventlisteners/delete/{id}. */
  providerId: string;
  /** Which canonical event this listener fires on (`booking:completed`, …). */
  event: IcabbiWebhookEvent;
  /** Name we registered, useful for surfacing in the iCabbi admin console. */
  name: string;
};

export type ResetWebhookListenersArgs = {
  appKey: string;
  secretKey: string;
  /** Callback URL including the ?token=<secret> shared secret. */
  callbackUrl: string;
  /** Previously-registered listener provider ids — these get deleted first. */
  existingProviderIds: string[];
  /** Per-partner API base URL override; see ICabbiCredentials.apiBaseUrl. */
  apiBaseUrl?: string;
  /** Optional override — defaults to ICABBI_WEBHOOK_EVENTS (all 13). */
  events?: readonly IcabbiWebhookEvent[];
};

export type ResetWebhookListenersResult = {
  deleted: number;
  created: WebhookListenerRecord[];
  errors: string[];
};

// 10s per call — iCabbi staging can be slow off-peak. If we're still
// timing out the endpoint is probably misconfigured, not just under
// load. 13 events × 10s sequentially = ~130s worst case; we run them
// concurrently below to keep the user-facing reset action snappy.
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Tear down all existing listeners on iCabbi, then register one
 * listener per event. Best-effort delete (errors collected, not
 * thrown). Hard create — if ANY create fails the result still includes
 * the successful ones so the caller can persist them; the caller is
 * expected to surface `errors` in the UI so an operator can retry.
 */
export async function resetWebhookListeners(
  args: ResetWebhookListenersArgs,
): Promise<ResetWebhookListenersResult> {
  const base = resolveBaseUrl(args.apiBaseUrl);
  const events = args.events ?? ICABBI_WEBHOOK_EVENTS;
  const errors: string[] = [];

  // ----- delete phase ----------------------------------------------------
  // Best-effort: log each failure but keep going. We DON'T want a single
  // 404 (listener already gone) to block re-creation.
  let deleted = 0;
  await Promise.all(
    args.existingProviderIds.map(async (id) => {
      const result = await deleteListener(base, args.appKey, args.secretKey, id);
      if (result.ok) deleted += 1;
      else errors.push(`delete ${id}: ${result.status} ${result.message ?? ""}`.trim());
    }),
  );

  // ----- create phase ----------------------------------------------------
  // Run in parallel — iCabbi accepts concurrent registrations, and 13
  // serial calls would make Connect feel laggy.
  const created: WebhookListenerRecord[] = [];
  await Promise.all(
    events.map(async (event) => {
      const result = await createListener(
        base,
        args.appKey,
        args.secretKey,
        event,
        args.callbackUrl,
      );
      if (result.ok) {
        created.push({
          providerId: result.providerId,
          event,
          name: result.name,
        });
      } else {
        errors.push(`create ${event}: ${result.status} ${result.message ?? ""}`.trim());
      }
    }),
  );

  return { deleted, created, errors };
}

async function createListener(
  base: string,
  appKey: string,
  secretKey: string,
  event: IcabbiWebhookEvent,
  url: string,
): Promise<
  | { ok: true; providerId: string; name: string }
  | { ok: false; status: number; message: string }
> {
  const name = buildListenerName(event);
  const body = {
    name,
    event,
    url,
    format: "json",
    template: "#json",
  };
  try {
    const res = await fetch(`${base}/eventlisteners/create`, {
      method: "POST",
      headers: {
        "App-Key": appKey,
        "Secret-Key": secretKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, message: text.slice(0, 300) };
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // fall through — parsed stays null, treated as missing id below
    }
    // iCabbi's response envelope: { eventlistener: { id, ... } }. Some
    // clusters return the listener at the top level — accept both shapes
    // so we don't get tripped up by a future API revision.
    const env = parsed as {
      eventlistener?: { id?: string | number };
      id?: string | number;
    } | null;
    const providerId = env?.eventlistener?.id ?? env?.id;
    if (providerId == null) {
      return {
        ok: false,
        status: 200,
        message: `no eventlistener.id in response: ${text.slice(0, 200)}`,
      };
    }
    return { ok: true, providerId: String(providerId), name };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return {
        ok: false,
        status: 0,
        message: `timed out after ${WEBHOOK_TIMEOUT_MS}ms calling ${base}/eventlisteners/create`,
      };
    }
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function deleteListener(
  base: string,
  appKey: string,
  secretKey: string,
  id: string,
): Promise<{ ok: boolean; status: number; message?: string }> {
  try {
    const res = await fetch(
      `${base}/eventlisteners/delete/${encodeURIComponent(id)}`,
      {
        method: "POST",
        headers: {
          "App-Key": appKey,
          "Secret-Key": secretKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      },
    );
    // 404 means it's already gone — treat as success for our purposes.
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, message: text.slice(0, 300) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compatibility shim — old name pointing at the new function. Lets the
 * integration page migrate one step at a time. Will be removed once
 * #237 lands.
 *
 * @deprecated use resetWebhookListeners
 */
export async function registerWebhookSubscription(_args: {
  appKey: string;
  secretKey: string;
  url: string;
  sharedSecret: string;
  apiBaseUrl?: string;
}): Promise<
  | { ok: true; subscriptionId: string }
  | { ok: false; status: number; message: string }
> {
  return {
    ok: false,
    status: 410,
    message:
      "registerWebhookSubscription is removed — call resetWebhookListeners instead. " +
      "The /webhooks/register endpoint doesn't exist on iCabbi; we use /eventlisteners/create.",
  };
}

/**
 * Compatibility shim — bulk-delete using the new endpoint. Lets the
 * integration page disconnect partners onboarded under the old
 * webhookSubscriptionId shape during the transition window.
 *
 * @deprecated use resetWebhookListeners with empty events
 */
export async function deleteWebhookSubscription(args: {
  appKey: string;
  secretKey: string;
  subscriptionId: string;
  apiBaseUrl?: string;
}): Promise<{ ok: boolean; status: number; message?: string }> {
  const base = resolveBaseUrl(args.apiBaseUrl);
  return deleteListener(base, args.appKey, args.secretKey, args.subscriptionId);
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

  async fetchBookingPayment(externalId: string): Promise<BookingPaymentSummary | null> {
    try {
      const path = `/bookings/${encodeURIComponent(externalId)}`;
      const res = await fetch(`${this.baseUrl()}${path}`, {
        method: "GET",
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : null;

      const envelope = json as { body?: { booking?: Record<string, unknown> } } | null;
      const booking = envelope?.body?.booking;
      if (!booking) return null;

      const payment = (booking.payment ?? {}) as Record<string, unknown>;
      const totalGbp = Number(payment.total ?? payment.cost ?? 0);
      const feeGbp = Number(payment.fee ?? 0);
      const processingFeeGbp = Number(payment.processing_fee ?? 0);

      return {
        totalPence: Math.round(totalGbp * 100),
        status: typeof payment.status === "string" ? payment.status : undefined,
        feePence: Math.round(feeGbp * 100),
        processingFeePence: Math.round(processingFeeGbp * 100),
        fixedFare: Number(payment.fixed ?? 0) === 1,
        tariffId:
          payment.tariff_id != null && Number(payment.tariff_id) > 0
            ? String(payment.tariff_id)
            : undefined,
      };
    } catch {
      return null;
    }
  }

  // ---------- internals ----------

  private baseUrl(): string {
    return resolveBaseUrl(this.creds.apiBaseUrl);
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

    // iCabbi has a documented quirk: most error responses come back as
    // HTTP 200 with the real status code in the response envelope. E.g.
    // auth failures return:
    //   HTTP/2 200
    //   { "code": 401, "error": true, "message": "Auth Credentials Invalid", ... }
    //
    // If we only checked res.ok we'd treat this as success, fail to find
    // an id in the empty body, and throw a misleading "no id in response"
    // error. Instead, check the envelope's code field. Treat any non-2xx
    // in-envelope code as a failure with the iCabbi-provided message.
    const envelope = json as
      | { code?: number; error?: boolean; message?: string; info?: { error_id?: string } }
      | null;
    const envelopeCode = envelope?.code;
    const envelopeError =
      envelope?.error === true ||
      (typeof envelopeCode === "number" && (envelopeCode < 200 || envelopeCode >= 300));

    if (!res.ok || envelopeError) {
      const code = res.ok ? envelopeCode ?? res.status : res.status;
      const msg = envelope?.message ?? text.slice(0, 300);
      const errorId = envelope?.info?.error_id ? ` (iCabbi error_id=${envelope.info.error_id})` : "";
      throw new Error(`iCabbi POST ${path} failed: ${code} ${msg}${errorId}`);
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
/**
 * Map iCabbi BDD-spec canonical status names ("Driver Assigned", "Passenger
 * On Board", etc.) to our internal transit_status enum. Used when iCabbi
 * sends statuses in the human-readable canonical form rather than the
 * UPPER_SNAKE_CASE codes that mapICabbiStatus handles.
 *
 * Returns null for unrecognised values so callers can log + skip rather
 * than coercing to a wrong state.
 */
function mapCanonicalStatus(raw: string): InternalTransitStatus | null {
  if (!raw) return null;
  // Normalise: lowercase, collapse whitespace, strip dashes/underscores
  const norm = raw.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  switch (norm) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "no_match";
    case "driver assigned":
      return "driver_assigned";
    case "driver arrived":
    case "arrived":
      return "driver_arrived";
    case "driver en route":
    case "en route":
    case "enroute":
      return "en_route";
    case "passenger on board":
    case "on board":
    case "in progress":
      return "on_board";
    case "completed":
      return "completed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

// Same enum type the icabbi-status-map module uses internally — local
// alias so we don't need a cross-file import for what's effectively
// strings.
type InternalTransitStatus =
  | "received"
  | "routing"
  | "no_match"
  | "pushed"
  | "accepted"
  | "driver_assigned"
  | "driver_arrived"
  | "en_route"
  | "on_board"
  | "completed"
  | "cancelled"
  | "failed"
  | "paused"
  | "error_auth"
  | "error_other";

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

  // ------------------------------------------------------------------------
  // iCabbi's actual outbound webhook shape (confirmed 2026-06-08 via Frank
  // Sims). Their dispatch system uses a Segment-style template:
  //
  //   {
  //     "userId":    "<booking customer phone>",
  //     "event":     "<event name configured in their dispatch>",
  //     "properties": {
  //       "booking_id": "...",
  //       "status":     "...",  // e.g. "DRIVER_ASSIGNED", "POB", "COMPLETED"
  //       "driver_name":         "...",
  //       "pickup_address":      "...",
  //       "destination_address": "...",
  //       "vehicle_reg":         "...",
  //       "eta":                 "..."
  //     },
  //     "timestamp": "<ISO 8601>"
  //   }
  //
  // This is what the staging COID 1102 tenant sends. The Karhoo-shaped
  // envelope below is left for forward-compat with iCabbi-as-Karhoo
  // partners (item #4 in ICABBI_DEPENDENCIES.md still open on whether
  // they have both flavours).
  // ------------------------------------------------------------------------
  const properties =
    payload.properties && typeof payload.properties === "object" && !Array.isArray(payload.properties)
      ? (payload.properties as Record<string, unknown>)
      : null;

  if (properties) {
    const bookingId = String(properties.booking_id ?? properties.bookingId ?? properties.id ?? "");
    const statusRaw = String(properties.status ?? "");

    // Detect iCabbi's "template not substituted" failure mode. If most
    // properties values start with '#' (their placeholder syntax —
    // #booking_id, #booking_status, etc.), it means iCabbi's webhook
    // config sent the raw template instead of filling in real values.
    // Log loudly so this is impossible to miss next time. Confirmed
    // 2026-06-08 with Frank Sims — this happened on first staging
    // integration and burned an hour of debug before we spotted it.
    const propVals = Object.values(properties).filter((v) => typeof v === "string") as string[];
    const placeholderCount = propVals.filter((v) => v.startsWith("#")).length;
    if (propVals.length > 0 && placeholderCount / propVals.length >= 0.5) {
      console.error(
        `[icabbi-adapter] ⚠️  TEMPLATE-NOT-SUBSTITUTED — iCabbi sent the raw webhook template ` +
          `with #placeholder values instead of real data. Count: ${placeholderCount}/${propVals.length} ` +
          `values are placeholders. Fix on iCabbi side: check the template engine config so it ` +
          `substitutes variables before delivering. Sample value: booking_id="${bookingId}", status="${statusRaw}".`,
      );
      // Return null + record this distinct outcome so /webhooks shows the
      // pattern explicitly. The webhook_deliveries.outcome field will
      // surface this in the inspector.
      return null;
    }

    if (!bookingId) {
      // We can't act without a booking id. Log so we can see the shape.
      console.warn(
        `[icabbi-adapter] iCabbi properties-shape webhook with no booking_id. ` +
          `event=${payload.event ?? "(none)"}. properties keys=${Object.keys(properties).join(",")}`,
      );
      return null;
    }

    // Map iCabbi's status value to our internal enum. mapICabbiStatus
    // handles UPPER_SNAKE_CASE codes (DRIVER_ASSIGNED, POB, COMPLETED).
    // If iCabbi sends canonical-spec status names ("Driver Assigned",
    // "Passenger On Board"), map those too.
    const normalisedStatus =
      mapICabbiStatus(statusRaw) ?? mapCanonicalStatus(statusRaw);

    if (!normalisedStatus) {
      console.warn(
        `[icabbi-adapter] unrecognised status "${statusRaw}" on iCabbi properties webhook for booking ${bookingId}. ` +
          `event=${payload.event ?? "(none)"}. Skipping (ack_unhandled).`,
      );
      return null;
    }

    // Build the detail bundle so the transit timeline + driver-details
    // panel can render whatever iCabbi provided this tick.
    const detail: Record<string, unknown> = {
      icabbi_status: statusRaw,
      event: payload.event ?? null,
      timestamp: payload.timestamp ?? null,
      user_id: payload.userId ?? null,
    };
    if (properties.driver_name) {
      detail.driver = {
        first_name: String(properties.driver_name).split(" ")[0] ?? "",
        last_name: String(properties.driver_name).split(" ").slice(1).join(" ") ?? "",
        phone_number: properties.driver_phone ?? null,
        license_number: properties.driver_license ?? null,
      };
    }
    if (properties.vehicle_reg) {
      detail.vehicle_license_plate = properties.vehicle_reg;
    }
    if (properties.eta != null) {
      detail.eta_minutes = Number(properties.eta);
    }
    if (properties.pickup_address) detail.pickup_address = properties.pickup_address;
    if (properties.destination_address) detail.destination_address = properties.destination_address;

    return {
      kind: "status",
      recipientBookingExternalId: bookingId,
      newStatus: normalisedStatus,
      detail,
    };
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
