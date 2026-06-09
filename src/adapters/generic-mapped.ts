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

const REQUEST_TIMEOUT_MS = 8_000;

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
    const endpoint = this.config?.endpoints?.create_booking;
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

    const res = await this.postJson(endpoint, mapped.payload);
    if (!res.ok) {
      throw new Error(`generic_mapped createBooking ${endpoint}: ${res.status} ${res.body.slice(0, 200)}`);
    }
    const parsed = safeJson(res.body);
    const reversed = parsed ? reverseMapping(parsed as Record<string, unknown>, this.config!) : null;

    // The partner's response should contain canonical booking.id under
    // reverse mapping. If absent, fall back to any obvious id field in
    // the raw response.
    const externalId =
      (reversed && reversed.ok ? (reversed.canonical as { booking?: { id?: string } }).booking?.id : undefined) ??
      String((parsed as { id?: string | number; job_id?: string; booking_id?: string } | null)?.id ??
              (parsed as { job_id?: string } | null)?.job_id ??
              (parsed as { booking_id?: string } | null)?.booking_id ?? "");

    if (!externalId) {
      throw new Error(
        `generic_mapped createBooking ${endpoint}: response has no recoverable booking id`,
      );
    }

    return { externalId, acceptedAt: new Date().toISOString() };
  }

  async cancelBooking({ externalId, reason }: CancelBookingInput): Promise<void> {
    const cancelEndpoint = this.config?.endpoints?.cancel;
    if (!cancelEndpoint) {
      log.warn("generic_mapped cancelBooking with no cancel endpoint configured", {
        partner_id: this.partnerId,
      });
      return;
    }
    const body = { booking_id: externalId, reason };
    await this.postJson(cancelEndpoint, body); // best-effort, no throw on non-2xx
  }

  async quote({ booking }: QuoteInput): Promise<QuoteResult> {
    const quoteEndpoint = this.config?.endpoints?.quote;
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

    const res = await this.postJson(quoteEndpoint, mapped.payload);
    if (!res.ok) {
      return {
        available: false,
        reason: `quote_status_${res.status}`,
      };
    }
    const parsed = safeJson(res.body);
    if (!parsed) return { available: false, reason: "quote_no_response_body" };

    const reversed = reverseMapping(parsed as Record<string, unknown>, this.config!);
    if (!reversed.ok) return { available: false, reason: "quote_reverse_mapping_failed" };

    const r = reversed.canonical as {
      eta_minutes?: number;
      fare?: { amount?: number; currency?: string };
      booking?: { status?: string };
    };
    // Treat any status indicating "we said yes" as available. Partners
    // that don't return a status in quote responses default to true.
    const status = r.booking?.status;
    const available = status === undefined ||
      ["Accepted", "Available"].includes(status);

    return {
      available,
      ...(r.eta_minutes != null ? { etaMinutes: r.eta_minutes } : {}),
      ...(r.fare?.amount != null ? { fareEstimatePence: Math.round(r.fare.amount * 100) } : {}),
      ...(r.fare?.currency ? { currency: r.fare.currency } : {}),
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

  private async postJson(
    url: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.authHeaders(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
