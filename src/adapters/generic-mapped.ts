import type {
  PartnerAdapter,
  CreateBookingInput,
  CreateBookingResult,
  CancelBookingInput,
  BookingPaymentSummary,
  NormalisedBooking,
  QuoteInput,
  QuoteResult,
} from "@/lib/types";
import {
  applyMapping,
  reverseMapping,
  loadMappingConfig,
  resolveEndpoint,
  type MappingConfig,
} from "@/lib/mapping-layer";
import { log } from "@/lib/logger";

/**
 * H2 — generic, configuration-driven adapter (Epic 3 first consumer).
 *
 * Reads partner.fieldMappings + partner.authMechanism + partner-credentials
 * at construction time. Calls applyMapping/reverseMapping at request time.
 * No partner-specific code anywhere in this file — adding a new partner is
 * a mapping-config row, not new TypeScript.
 *
 * Per STRATEGY.md decision #13: hand-coded adapters (mock_icabbi,
 * mock_freenow, mock_cmac, real icabbi) stay for MVP partners. This
 * adapter is what wires up partner #4 onwards.
 *
 * Supported authentication mechanisms in this iteration:
 *   - icabbi_app_secret  — App-Key + Secret-Key headers (default, default for
 *                          backwards-compat — but typically use the real
 *                          icabbi adapter for those)
 *   - api_key_header     — single static API key in a configurable header
 *   - basic              — HTTP Basic auth
 *
 * Deferred (not in this iteration):
 *   - oauth2 — needs token caching + refresh; significant scope. Defer until
 *              first partner that requires it. Throws if attempted today.
 */

// Per-call HTTP timeout. Long-form: external aggregators (CMAC, FreeNow)
// hit downstream suppliers on a quote and can take 10-30s for cold paths.
// The 1500ms fan-out NFR is enforced at the orchestrator (POST /api/quote
// races adapters with Promise.race + setTimeout), so a generous adapter
// timeout doesn't break fan-out latency — it just keeps the underlying
// HTTP request alive for the background "we still want to know" case.
const REQUEST_TIMEOUT_MS = 30_000;

type AuthMechanism = "icabbi_app_secret" | "oauth2" | "api_key_header" | "basic";

type GenericMappedCredentials = {
  // Mechanism marker — required (drives which auth-config sub-shape is used)
  authMechanism?: AuthMechanism;
  // icabbi_app_secret
  appKey?: string;
  secretKey?: string;
  // api_key_header
  apiKeyHeaderName?: string;
  apiKey?: string;
  // basic
  username?: string;
  password?: string;
  // For convenience: per-partner override of endpoint URLs that aren't in
  // the mapping config (e.g. fetch-payment URL the BDD spec doesn't cover).
  fetchPaymentUrl?: string;
};

export class GenericMappedAdapter implements PartnerAdapter {
  readonly key = "generic_mapped";

  private config: MappingConfig | null;

  constructor(
    public readonly partnerId: string,
    private readonly creds: GenericMappedCredentials,
    rawMappingConfig: unknown,
  ) {
    this.config = loadMappingConfig(partnerId, rawMappingConfig);
    if (!this.config) {
      // Without a mapping config, this adapter can't translate. Caller
      // (the registry) should have routed to a hand-coded adapter instead.
      throw new Error(
        `GenericMappedAdapter ${partnerId}: partners.fieldMappings is empty or invalid — set a config or use a different adapterKey`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PartnerAdapter contract
  // -------------------------------------------------------------------------

  async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
    const endpoint = resolveEndpoint(this.config?.endpoints?.create_booking);
    if (!endpoint) {
      throw new Error(
        `GenericMappedAdapter ${this.partnerId}: no create_booking endpoint in mapping config`,
      );
    }

    const canonical = canonicalFromBooking(input.booking);
    const mapped = applyMapping(canonical, this.config!);
    if (!mapped.ok) {
      throw new Error(
        `GenericMappedAdapter ${this.partnerId}: missing required fields ${mapped.missing.join(", ")}`,
      );
    }
    if (mapped.warnings.length > 0) {
      log.warn("generic_mapped createBooking mapping warnings", {
        partner_id: this.partnerId,
        warnings: mapped.warnings,
      });
    }

    const res = await this.request(endpoint.url, endpoint.method, mapped.payload);
    if (!res.ok) {
      throw new Error(`generic_mapped createBooking ${endpoint.url}: ${res.status} ${res.body.slice(0, 200)}`);
    }
    const parsed = safeJson(res.body) as
      | (Record<string, unknown> & {
          id?: string | number;
          jobId?: string | number;
          bookingId?: string | number;
          job_id?: string | number;
          booking_id?: string | number;
        })
      | null;
    const reversed = parsed ? reverseMapping(parsed, this.config!) : null;

    // External-id resolution order matters. Partners commonly echo our own
    // customerReference back in the response — if reverseMapping runs first,
    // it grabs OUR reference into `canonical.booking.id` and we lose the
    // partner's actual job id. So we look at the partner-side id fields
    // FIRST and only fall back to reverseMapping when none of the
    // conventional names are present.
    //
    // Common partner id field names: `id` (CMAC, FreeNow, most REST APIs),
    // `jobId` / `job_id` (CMAC's response uses `id` but some partners alias),
    // `bookingId` / `booking_id`. We coerce to string because partners use
    // a mix of numeric and string id types (CMAC's id is a number;
    // iCabbi's is a uuid-ish string).
    const partnerSideId =
      parsed?.id ?? parsed?.jobId ?? parsed?.bookingId ?? parsed?.job_id ?? parsed?.booking_id;
    const reverseId =
      reversed && reversed.ok
        ? (reversed.canonical as { booking?: { id?: string | number } }).booking?.id
        : undefined;
    const externalId = partnerSideId ?? reverseId ?? "";

    if (!externalId && externalId !== 0) {
      throw new Error(
        `generic_mapped createBooking ${endpoint.url}: response has no recoverable booking id`,
      );
    }

    return { externalId: String(externalId), acceptedAt: new Date().toISOString() };
  }

  async cancelBooking({ externalId, reason }: CancelBookingInput): Promise<void> {
    const cancelEndpoint = resolveEndpoint(this.config?.endpoints?.cancel, externalId);
    if (!cancelEndpoint) {
      log.warn("generic_mapped cancelBooking with no cancel endpoint configured", {
        partner_id: this.partnerId,
      });
      return;
    }
    // For DELETE-style cancels (e.g. CMAC) we don't send a body. For
    // POST-style cancels, supply the canonical body shape.
    const body = cancelEndpoint.method === "DELETE" ? undefined : { booking_id: externalId, reason };
    await this.request(cancelEndpoint.url, cancelEndpoint.method, body); // best-effort
  }

  async quote({ booking }: QuoteInput): Promise<QuoteResult> {
    const quoteEndpoint = resolveEndpoint(this.config?.endpoints?.quote);
    if (!quoteEndpoint) {
      // No quote endpoint configured — caller (fan-out) will treat as
      // "no adapter quote method" and use the synthetic fallback.
      return { available: true };
    }

    const canonical = canonicalFromBooking(booking);
    const mapped = applyMapping(canonical, this.config!);
    if (!mapped.ok) {
      return { available: false, reason: "missing_required_fields" };
    }

    const res = await this.request(quoteEndpoint.url, quoteEndpoint.method, mapped.payload);
    if (!res.ok) {
      return {
        available: false,
        reason: `quote_status_${res.status}`,
      };
    }
    const parsed = safeJson(res.body) as Record<string, unknown> | null;
    if (!parsed) return { available: false, reason: "quote_no_response_body" };

    // reverseMapping is symmetric with applyMapping (uses the same field
    // map). For partners whose quote response shape mirrors the create
    // request shape, that's fine. For partners with asymmetric quote
    // responses (CMAC: request has `from`/`to`/`vehicleType`; response has
    // `price`/`jobQuotes`/`distance`), reverseMapping yields nothing
    // useful. We fall through to convention-based extraction below.
    const reversed = reverseMapping(parsed, this.config!);
    const reversedCanonical = reversed.ok
      ? (reversed.canonical as {
          eta_minutes?: number;
          fare?: { amount?: number; currency?: string };
          booking?: { status?: string };
        })
      : null;

    // Status check — only treat as available when the partner explicitly
    // says so. Partners that don't return a status default to "available
    // means we got a response".
    const status = reversedCanonical?.booking?.status;
    if (status !== undefined && !["Accepted", "Available"].includes(status)) {
      return { available: false, reason: `quote_status_field_${status}` };
    }

    // Some partners use a top-level success boolean (CMAC: `"success": true`).
    // When false, the partner is explicitly saying "we can't do this trip".
    const success = parsed.success;
    if (success === false) {
      const err = typeof parsed.error === "string" ? parsed.error : "quote_success_false";
      return { available: false, reason: err };
    }

    // Convention-based extraction of fare/eta. Tries reverseMapping first
    // (explicit config wins), then falls back to common partner-side field
    // names. This means a partner like CMAC works out of the box without
    // needing to declare a response_fields config — at the cost of being
    // wrong for partners with quirky field names. When wrong, the partner
    // should add explicit mappings.
    const fareMajor =
      reversedCanonical?.fare?.amount ??
      pickNumber(parsed, "price", "fareAmount", "fare", "amount", "estimateFare");
    const currency =
      reversedCanonical?.fare?.currency ??
      pickString(parsed, "currency", "fareCurrency", "currencyCode");
    const etaMinutes =
      reversedCanonical?.eta_minutes ??
      pickNumber(parsed, "etaMinutes", "etaMin", "eta_minutes") ??
      // CMAC nests per-supplier ETA inside jobQuotes[0]. Take the first
      // entry (CMAC ranks by price ascending; their cheapest supplier's
      // ETA is closest to a "real" availability signal).
      (() => {
        const seconds =
          pickNumber(parsed, "etaInSeconds", "eta_seconds", "etaSeconds") ??
          pickNumber(firstObjectIn(parsed, "jobQuotes", "suppliers", "offers"), "etaInSeconds", "etaSeconds");
        return seconds != null ? Math.round(seconds / 60) : undefined;
      })();

    return {
      available: true,
      ...(etaMinutes != null ? { etaMinutes } : {}),
      ...(fareMajor != null ? { fareEstimatePence: Math.round(fareMajor * 100) } : {}),
      ...(currency ? { currency } : {}),
    };
  }

  async fetchBookingPayment(externalId: string): Promise<BookingPaymentSummary | null> {
    // No standard endpoint for this in the BDD canonical schema. Each
    // partner's payment retrieval lives at a partner-specific URL —
    // we expose it via creds.fetchPaymentUrl as an optional override.
    if (!this.creds.fetchPaymentUrl) return null;
    const url = this.creds.fetchPaymentUrl.replace("{id}", encodeURIComponent(externalId));
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const text = await res.text();
      const parsed = safeJson(text);
      if (!parsed) return null;
      // Use reverse mapping to pull canonical fare.amount / fare.currency
      const reversed = reverseMapping(parsed as Record<string, unknown>, this.config!);
      if (!reversed.ok) return null;
      const r = reversed.canonical as { fare?: { amount?: number; currency?: string } };
      const amount = r.fare?.amount;
      if (typeof amount !== "number") return null;
      return {
        totalPence: Math.round(amount * 100),
        status: "received",
      };
    } catch {
      return null;
    }
  }

  async normaliseInboundWebhook(payload: Record<string, unknown>) {
    // Generic-mapped inbound: reverse-map the payload to canonical,
    // then convert to status update (if it looks like a status event)
    // or null otherwise. Webhook ingress for a generic_mapped partner
    // depends entirely on what the partner sends.
    const reversed = reverseMapping(payload, this.config!);
    if (!reversed.ok) return null;
    const r = reversed.canonical as {
      booking?: { id?: string; status?: string };
    };
    if (r.booking?.id && r.booking?.status) {
      return {
        kind: "status" as const,
        recipientBookingExternalId: r.booking.id,
        newStatus: r.booking.status,
        detail: payload,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    const m = (this.creds.authMechanism ?? "icabbi_app_secret") as AuthMechanism;
    switch (m) {
      case "icabbi_app_secret":
        return {
          "App-Key": this.creds.appKey ?? "",
          "Secret-Key": this.creds.secretKey ?? "",
        };
      case "api_key_header":
        return {
          [this.creds.apiKeyHeaderName ?? "X-API-Key"]: this.creds.apiKey ?? "",
        };
      case "basic": {
        const u = this.creds.username ?? "";
        const p = this.creds.password ?? "";
        const token = Buffer.from(`${u}:${p}`).toString("base64");
        return { Authorization: `Basic ${token}` };
      }
      case "oauth2":
        // Deferred — needs token caching + refresh logic. Surface as a
        // clear error rather than silently failing auth.
        throw new Error(
          `generic_mapped: oauth2 auth mechanism not implemented (partner ${this.partnerId})`,
        );
      default:
        throw new Error(`generic_mapped: unknown auth mechanism "${m}"`);
    }
  }

  private async request(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    try {
      // GET / DELETE typically carry no body. POST / PUT / PATCH do.
      const hasBody = body !== undefined && method !== "GET" && method !== "DELETE";
      const res = await fetch(url, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          Accept: "application/json",
        },
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      // Log non-2xx so the response body isn't silently swallowed in quote/
      // cancel/fetchPayment paths. createBooking throws and includes the body
      // in the error message, but those other call sites only get back a
      // boolean — without this log, debugging field-name mismatches with a
      // new partner is impossible.
      //
      // Also log 2xx response bodies at info level — needed to learn a new
      // partner's response shape (which id field to read, what status names
      // they emit, etc.). Body capped at 1k chars. Set
      // GENERIC_MAPPED_QUIET=1 in prod to suppress 2xx response bodies once
      // the partner shape is locked in.
      if (!res.ok) {
        log.warn("generic_mapped non-2xx response", {
          partner_id: this.partnerId,
          method,
          url,
          status: res.status,
          body: text.slice(0, 1000),
          ...(hasBody ? { request_body: JSON.stringify(body).slice(0, 1000) } : {}),
        });
      } else if (process.env.GENERIC_MAPPED_QUIET !== "1") {
        log.info("generic_mapped 2xx response", {
          partner_id: this.partnerId,
          method,
          url,
          status: res.status,
          body: text.slice(0, 1000),
        });
      }
      return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("generic_mapped request threw", {
        partner_id: this.partnerId,
        method,
        url,
        err: msg,
      });
      return { ok: false, status: 0, body: msg };
    }
  }
}

/**
 * Translate our internal NormalisedBooking into the canonical
 * dot-notation object the mapping engine expects. Mirrors the schema
 * in docs/CANONICAL_FIELDS.md.
 */
function canonicalFromBooking(b: NormalisedBooking): Record<string, unknown> {
  return {
    pickup: {
      lat: b.pickup.lat,
      lng: b.pickup.lng,
      address: b.pickup.address,
    },
    dropoff: {
      lat: b.dropoff.lat,
      lng: b.dropoff.lng,
      address: b.dropoff.address,
    },
    vehicle_type: b.vehicleType,
    passenger: {
      name: b.passenger.name,
      phone: b.passenger.phone,
      count: b.passengerCount,
    },
    booking: {
      id: b.originatorBookingExternalId,
      type: b.bookingType === "prebook" ? "PREBOOK" : "ASAP",
      ...(b.scheduledFor ? { scheduled_at: b.scheduledFor } : {}),
    },
    ...(b.fareEstimatePence != null
      ? { fare: { amount: b.fareEstimatePence / 100, currency: "GBP" } }
      : {}),
    ...(b.instructions ? { instructions: b.instructions } : {}),
    ...(b.notes ? { notes: b.notes } : {}),
  };
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Return the first numeric value found at any of the given top-level keys
 * of `obj`. Used in convention-based response parsing where a partner
 * could call the same canonical concept several different names (e.g.
 * `price`, `fare`, `fareAmount`, `amount`).
 */
function pickNumber(obj: Record<string, unknown> | null | undefined, ...keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Mirror of pickNumber for strings. */
function pickString(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Look at the first object inside any of the named array properties.
 * Used for partners that return per-supplier quote arrays — we read the
 * first entry as the "headline" quote (CMAC ranks by price ascending so
 * jobQuotes[0] is their best offer).
 */
function firstObjectIn(obj: Record<string, unknown> | null | undefined, ...keys: string[]): Record<string, unknown> | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] != null) {
      return v[0] as Record<string, unknown>;
    }
  }
  return null;
}
