import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericMappedAdapter } from "@/adapters/generic-mapped";
import { clearMappingCache } from "@/lib/mapping-layer";
import { log } from "@/lib/logger";
import type { CreateBookingInput, NormalisedBooking } from "@/lib/types";
import type { FeeSnapshot } from "@/db/schema";

/**
 * H2 GenericMappedAdapter — the zero-per-partner-code adapter (CMAC runs on a
 * mapping-config row, not new TS). Locks in: fast-fail construction without a
 * usable config; per-endpoint URL/method/{external_id} templating; every auth
 * mechanism's exact wire headers (incl. deliberately-unimplemented oauth2);
 * byte-for-byte request body mapping; response extraction (partner-id
 * precedence, convention fare/eta fallback, status / success:false rejection);
 * and error paths that degrade rather than throw. fetch stubbed; the EXACT
 * constructed request is asserted as the wire contract.
 */

// CMAC-flavoured mapping config: address from/to, numeric vehicle enums, a
// customerReference echo, local-time pickup datetime, numeric status vocab.
// Mirrors a real config-driven partners.fieldMappings row.
const partnerConfig = {
  fields: {
    "pickup.address": { partner_field: "from", required: true },
    "dropoff.address": { partner_field: "to", required: true },
    "passenger.name": { partner_field: "passengerName" },
    "passenger.phone": { partner_field: "passengerPhone" },
    vehicle_type: { partner_field: "vehicleType", value_lookup: { standard: 1, exec: 6 } },
    "booking.id": { partner_field: "customerReference" },
    "booking.scheduled_at": {
      partner_field: "pickupDateTime",
      transform: { type: "format_datetime", format: "yyyy-MM-dd HH:mm", tz: "Europe/London" },
    },
    "fare.amount": { partner_field: "price" },
    "booking.status": {
      partner_field: "status",
      value_lookup_reverse: { "1": "Accepted", "9": "Rejected" },
    },
  },
  endpoints: {
    create_booking: { url: "https://partner.example/jobs", method: "POST" },
    quote: "https://partner.example/quotes", // string form → POST assumed
    cancel: { url: "https://partner.example/jobs/{external_id}", method: "DELETE" },
  },
};

/** Clone the base config with endpoint overrides (delete a key by passing undefined). */
function configWithEndpoints(endpoints: Record<string, unknown> | undefined) {
  return { ...partnerConfig, endpoints };
}

const apiKeyCreds = {
  authMechanism: "api_key_header" as const,
  apiKeyHeaderName: "X-Partner-Key",
  apiKey: "key-123",
};

const booking: NormalisedBooking = {
  originatorBookingExternalId: "ORIG-REF-1",
  bookingType: "asap",
  channel: "api",
  pickup: { lat: 51.507, lng: -0.128, address: "Trafalgar Square" },
  dropoff: { lat: 51.47, lng: -0.454, address: "Heathrow T5" },
  vehicleType: "standard",
  passengerCount: 2,
  passenger: { name: "Ada Lovelace", phone: "+447700900123" },
  raw: {},
};

const feeSnapshot: FeeSnapshot = {
  sendFeePence: 20,
  receiveFeePence: 40,
  techFeePence: 0,
  techFeeBps: 0,
  bookingFeePence: 0,
  adminFeePence: 0,
  adminFeeBps: 0,
  computedPassengerAddOnsPence: 0,
  fareAtSnapshotPence: null,
  resolvedFromFeeConfigId: "system_default",
};

function createInput(b: NormalisedBooking = booking): CreateBookingInput {
  return { transitId: "tr-1", recipientPartnerId: "ptr-x", booking: b, feeSnapshot };
}

// Unique partner id per adapter so the per-partner config cache can't bleed
// one test's config into another.
let partnerSeq = 0;
function makeAdapter(
  creds: ConstructorParameters<typeof GenericMappedAdapter>[1] = apiKeyCreds,
  config: unknown = partnerConfig,
) {
  return new GenericMappedAdapter(`ptr-gm-${++partnerSeq}`, creds, config);
}

/** Minimal fetch Response stand-in — only what the adapter reads (ok/status/text). */
function fetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Stub global fetch with a single canned response; returns the mock for call assertions. */
function stubFetch(status: number, body: unknown) {
  // (url, init) sig so mock.calls[0] is typed wide enough to assert on.
  const mock = vi.fn(async (..._args: [string, RequestInit]) => fetchResponse(status, body));
  vi.stubGlobal("fetch", mock);
  return mock;
}

// Silence the adapter's request/response logging; tests that assert on it
// re-spy.
let logInfoSpy: ReturnType<typeof vi.spyOn>;
let logWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearMappingCache();
  logInfoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
  logWarnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearMappingCache();
});

describe("GenericMappedAdapter — construction", () => {
  it("throws when the partner has no mapping config at all", () => {
    // No config → can't translate → loud failure, not a broken adapter.
    expect(() => makeAdapter(apiKeyCreds, null)).toThrow(/fieldMappings is empty or invalid/);
  });

  it("throws when the config has no usable fields block", () => {
    // A malformed config is the same as none — fail at construction.
    expect(() => makeAdapter(apiKeyCreds, { not_fields: {} })).toThrow(
      /fieldMappings is empty or invalid/,
    );
  });
});

describe("createBooking — request construction", () => {
  it("sends the exact mapped body, URL, method and auth header", async () => {
    // Canonical booking in, partner-shaped request out — assert every part.
    const fetchMock = stubFetch(200, { id: 9911 });
    const adapter = makeAdapter();

    const result = await adapter.createBooking(createInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://partner.example/jobs");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-Partner-Key": "key-123",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    // Body is EXACTLY the mapped fields — nothing unmapped leaks (lat/lng/pax
    // have no mapping → omitted).
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Trafalgar Square",
      to: "Heathrow T5",
      passengerName: "Ada Lovelace",
      passengerPhone: "+447700900123",
      vehicleType: 1, // value_lookup standard → numeric enum
      customerReference: "ORIG-REF-1",
    });
    expect(result.externalId).toBe("9911"); // numeric partner id coerced to string
    expect(Number.isNaN(Date.parse(result.acceptedAt))).toBe(false);
  });

  it("converts prebook scheduledFor to the partner's local-time wire format", async () => {
    // format_datetime end-to-end: ISO UTC in → "yyyy-MM-dd HH:mm"
    // Europe/London (BST +1h) out, fare in major units (4250p → 42.5).
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter();

    await adapter.createBooking(
      createInput({
        ...booking,
        bookingType: "prebook",
        scheduledFor: "2026-08-01T10:30:00Z",
        fareEstimatePence: 4250,
      }),
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.pickupDateTime).toBe("2026-08-01 11:30");
    expect(body.price).toBe(42.5);
  });

  it("throws and never calls fetch when a required canonical field is missing", async () => {
    // A required-field gap blocks the booking before any network call — a
    // half-formed job is worse than failing.
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter();
    const noDropoff = { ...booking, dropoff: { ...booking.dropoff, address: undefined as unknown as string } };

    await expect(adapter.createBooking(createInput(noDropoff))).rejects.toThrow(
      /missing required fields dropoff.address/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs mapping warnings but still creates the booking (BDD Story 3.1)", async () => {
    // An unknown vehicle type is a gap, not a blocker: warn, pass raw, proceed.
    stubFetch(200, { id: 77 });
    const adapter = makeAdapter();

    const result = await adapter.createBooking(
      createInput({ ...booking, vehicleType: "limo_xl" }),
    );

    expect(result.externalId).toBe("77");
    expect(logWarnSpy).toHaveBeenCalledWith(
      "generic_mapped createBooking mapping warnings",
      expect.objectContaining({ warnings: expect.arrayContaining([expect.stringContaining("vehicle_type")]) }),
    );
  });

  it("throws with status + body excerpt on a non-2xx response", async () => {
    // The partner's error body is the operator's only debugging signal — it
    // must surface in the thrown message.
    stubFetch(422, { error: "no coverage in area" });
    const adapter = makeAdapter();

    await expect(adapter.createBooking(createInput())).rejects.toThrow(
      /createBooking https:\/\/partner.example\/jobs: 422 .*no coverage in area/,
    );
  });

  it("throws when no create_booking endpoint is configured", async () => {
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter(apiKeyCreds, configWithEndpoints({ quote: "https://x/q" }));

    await expect(adapter.createBooking(createInput())).rejects.toThrow(
      /no create_booking endpoint/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createBooking — external id recovery", () => {
  it("prefers the partner-side id over our echoed customerReference", async () => {
    // Ordering-bug guard: partners echo OUR reference back; reverseMapping
    // first would store our reference as the job id and lose the booking.
    stubFetch(200, { id: 4242, customerReference: "ORIG-REF-1" });
    const adapter = makeAdapter();

    const result = await adapter.createBooking(createInput());
    expect(result.externalId).toBe("4242"); // NOT "ORIG-REF-1"
  });

  it("falls back to reverse-mapped booking.id when no conventional id field exists", async () => {
    // A custom-named id mapped via config (booking.id ← customerReference)
    // still yields a usable id.
    stubFetch(200, { customerReference: "PARTNER-JOB-9" });
    const adapter = makeAdapter();

    const result = await adapter.createBooking(createInput());
    expect(result.externalId).toBe("PARTNER-JOB-9");
  });

  it("accepts conventional alias fields (jobId)", async () => {
    // Convention id sniffing: jobId/bookingId/job_id/booking_id all count.
    stubFetch(200, { jobId: "J-555" });
    const adapter = makeAdapter();

    const result = await adapter.createBooking(createInput());
    expect(result.externalId).toBe("J-555");
  });

  it("treats numeric id 0 as a valid id, not a missing one", async () => {
    // The `!externalId && externalId !== 0` guard: 0 is a valid id, not missing.
    stubFetch(200, { id: 0 });
    const adapter = makeAdapter();

    const result = await adapter.createBooking(createInput());
    expect(result.externalId).toBe("0");
  });

  it("throws when the 2xx response has no recoverable id", async () => {
    // A success with no id is unusable (can't cancel/track) — fail loudly.
    stubFetch(200, { ok: true });
    const adapter = makeAdapter();

    await expect(adapter.createBooking(createInput())).rejects.toThrow(
      /no recoverable booking id/,
    );
  });

  it("throws on a 2xx response with a non-JSON body", async () => {
    // 200 + HTML error page → safeJson null → id resolution fails cleanly.
    stubFetch(200, "<html>load balancer says hi</html>");
    const adapter = makeAdapter();

    await expect(adapter.createBooking(createInput())).rejects.toThrow(
      /no recoverable booking id/,
    );
  });
});

describe("cancelBooking", () => {
  it("sends DELETE to the {external_id}-templated URL with no body", async () => {
    // CMAC-style DELETE /Jobs/{id}: id URL-encoded, no JSON body/Content-Type.
    const fetchMock = stubFetch(204, "");
    const adapter = makeAdapter();

    await adapter.cancelBooking({ externalId: "AB 12/X", reason: "passenger no-show" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://partner.example/jobs/AB%2012%2FX"); // encodeURIComponent applied
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("sends a JSON body for POST-style cancels", async () => {
    // Partners without RESTful deletes get the canonical cancel body shape.
    const fetchMock = stubFetch(200, "{}");
    const adapter = makeAdapter(
      apiKeyCreds,
      configWithEndpoints({ cancel: { url: "https://partner.example/cancel", method: "POST" } }),
    );

    await adapter.cancelBooking({ externalId: "B-9", reason: "rebooked" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ booking_id: "B-9", reason: "rebooked" });
  });

  it("is a logged no-op when no cancel endpoint is configured", async () => {
    // Missing cancel endpoint must not throw mid-flow — warn and return.
    const fetchMock = stubFetch(200, "{}");
    const adapter = makeAdapter(apiKeyCreds, configWithEndpoints({ create_booking: "https://x/jobs" }));

    await expect(adapter.cancelBooking({ externalId: "B-1", reason: "r" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logWarnSpy).toHaveBeenCalledWith(
      "generic_mapped cancelBooking with no cancel endpoint configured",
      expect.anything(),
    );
  });

  it("does not throw when the partner rejects the cancel (best-effort contract)", async () => {
    // Cancel is best-effort: a partner 500 must not wedge our cancellation.
    stubFetch(500, "boom");
    const adapter = makeAdapter();

    await expect(adapter.cancelBooking({ externalId: "B-1", reason: "r" })).resolves.toBeUndefined();
  });
});

describe("quote", () => {
  it("returns available:true without any HTTP call when no quote endpoint is configured", async () => {
    // Fan-out contract: no quote endpoint → assume available (synthetic ETA
    // upstream keeps the candidate eligible).
    const fetchMock = stubFetch(200, "{}");
    const adapter = makeAdapter(apiKeyCreds, configWithEndpoints({ create_booking: "https://x/jobs" }));

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unavailable (not a throw) when required fields can't be mapped", async () => {
    // Quote is a soft probe — mapping failure → available:false, not a throw.
    const fetchMock = stubFetch(200, "{}");
    const adapter = makeAdapter();
    const noPickup = { ...booking, pickup: { ...booking.pickup, address: undefined as unknown as string } };

    const q = await adapter.quote({ booking: noPickup });
    expect(q).toEqual({ available: false, reason: "missing_required_fields" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx as quote_status_<code>", async () => {
    stubFetch(503, "overloaded");
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: false, reason: "quote_status_503" });
  });

  it("surfaces a network failure as quote_status_0, never an exception", async () => {
    // request() turns a thrown fetch into { ok:false, status:0 } — quote
    // never throws for infra reasons.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: false, reason: "quote_status_0" });
  });

  it("returns unavailable when the 2xx response has no parseable body", async () => {
    stubFetch(200, "");
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: false, reason: "quote_no_response_body" });
  });

  it("rejects when the reverse-mapped status is not Accepted/Available", async () => {
    // Status 9 reverse-maps to "Rejected" — an explicit "no" wins over price.
    stubFetch(200, { status: 9, price: 10 });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: false, reason: "quote_status_field_Rejected" });
  });

  it("accepts when the reverse-mapped status is Accepted and extracts the fare", async () => {
    // Status 1 → "Accepted"; price via fare.amount mapping (major → pence).
    stubFetch(200, { status: 1, price: 18.6 });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q.available).toBe(true);
    expect(q.fareEstimatePence).toBe(1860);
  });

  it("treats success:false with an error string as that reason", async () => {
    // CMAC-style top-level success:false — partner's own wording preserved.
    stubFetch(200, { success: false, error: "no suppliers in zone" });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: false, reason: "no suppliers in zone" });
  });

  it("falls back to quote_success_false when success:false has no error string", async () => {
    stubFetch(200, { success: false });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: false, reason: "quote_success_false" });
  });

  it("extracts fare/eta/currency by convention when the config doesn't map them (CMAC out-of-the-box)", async () => {
    // Convention fallback (zero response_fields config): fareAmount/
    // currencyCode unmapped, ETA nested in jobQuotes[0].etaInSeconds.
    stubFetch(200, {
      success: true,
      fareAmount: 23.45,
      currencyCode: "EUR",
      jobQuotes: [{ etaInSeconds: 600 }, { etaInSeconds: 9999 }],
    });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({
      available: true,
      etaMinutes: 10, // jobQuotes[0] (cheapest supplier), 600s → 10min
      fareEstimatePence: 2345,
      currency: "EUR",
    });
  });

  it("reads a top-level etaInSeconds and rounds to minutes", async () => {
    stubFetch(200, { etaInSeconds: 290 }); // 4.83 min → rounds to 5
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: true, etaMinutes: 5 });
  });

  it("reads etaMinutes directly when the partner provides it", async () => {
    stubFetch(200, { etaMinutes: 7 });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: true, etaMinutes: 7 });
  });

  it("returns bare available:true when the response has no status, fare or eta", async () => {
    // "Available = we got a response" default — no phantom fare/eta fields.
    stubFetch(200, { something: "else" });
    const adapter = makeAdapter();

    const q = await adapter.quote({ booking });
    expect(q).toEqual({ available: true });
  });
});

describe("fetchBookingPayment", () => {
  const basicCreds = {
    authMechanism: "basic" as const,
    username: "u",
    password: "p",
    fetchPaymentUrl: "https://partner.example/payments/{id}",
  };

  it("returns null without any HTTP when no fetchPaymentUrl is configured", async () => {
    const fetchMock = stubFetch(200, "{}");
    const adapter = makeAdapter(); // apiKeyCreds — no fetchPaymentUrl

    expect(await adapter.fetchBookingPayment("B-1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETs the {id}-substituted URL with auth headers and reverse-maps the total", async () => {
    // Happy path: partner's `price` reverse-maps to fare.amount → pence.
    const fetchMock = stubFetch(200, { price: 12.34 });
    const adapter = makeAdapter(basicCreds);

    const summary = await adapter.fetchBookingPayment("J/9");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://partner.example/payments/J%2F9"); // {id} encoded
    expect(init.method).toBe("GET");
    // HTTP Basic base64("u:p") — exact header value is the wire contract.
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`,
    );
    expect(summary).toEqual({ totalPence: 1234, status: "received" });
  });

  it("returns null on a non-2xx response", async () => {
    stubFetch(404, "not found");
    const adapter = makeAdapter(basicCreds);
    expect(await adapter.fetchBookingPayment("B-1")).toBeNull();
  });

  it("returns null on a non-JSON body", async () => {
    stubFetch(200, "plain text");
    const adapter = makeAdapter(basicCreds);
    expect(await adapter.fetchBookingPayment("B-1")).toBeNull();
  });

  it("returns null when the response carries no numeric fare amount", async () => {
    // No usable total is no record — reconciliation must not get totalPence:NaN.
    stubFetch(200, { price: "twelve quid" });
    const adapter = makeAdapter(basicCreds);
    expect(await adapter.fetchBookingPayment("B-1")).toBeNull();
  });

  it("returns null when fetch itself throws (network down)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    }));
    const adapter = makeAdapter(basicCreds);
    expect(await adapter.fetchBookingPayment("B-1")).toBeNull();
  });
});

describe("normaliseInboundWebhook", () => {
  it("converts a reverse-mappable payload with id + status into a status event", async () => {
    // Partner field names (customerReference, numeric status) → canonical
    // status update, raw payload kept as detail.
    const adapter = makeAdapter();
    const payload = { customerReference: "B-77", status: 1 };

    const event = await adapter.normaliseInboundWebhook(payload);
    expect(event).toEqual({
      kind: "status",
      recipientBookingExternalId: "B-77",
      newStatus: "Accepted", // value_lookup_reverse: 1 → Accepted
      detail: payload,
    });
  });

  it("returns null when the payload lacks an id or status", async () => {
    // Uninterpretable webhooks are dropped (null), not guessed at.
    const adapter = makeAdapter();
    expect(await adapter.normaliseInboundWebhook({ customerReference: "B-77" })).toBeNull();
    expect(await adapter.normaliseInboundWebhook({ unrelated: true })).toBeNull();
  });
});

describe("auth mechanisms — exact wire headers", () => {
  it("defaults to icabbi_app_secret (App-Key / Secret-Key) when no mechanism is set", async () => {
    // Backwards-compat default.
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter({ appKey: "AK-1", secretKey: "SK-2" });

    await adapter.createBooking(createInput());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "App-Key": "AK-1", "Secret-Key": "SK-2" });
  });

  it("sends empty-string headers rather than crashing when icabbi creds are absent", async () => {
    // Misconfigured creds → partner-side 401, not a local TypeError (the
    // `?? ""` defaulting).
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter({});

    await adapter.createBooking(createInput());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "App-Key": "", "Secret-Key": "" });
  });

  it("api_key_header falls back to the X-API-Key header name", async () => {
    // apiKeyHeaderName is optional — default header must stay stable (docs ref it).
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter({ authMechanism: "api_key_header", apiKey: "k-9" });

    await adapter.createBooking(createInput());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "X-API-Key": "k-9" });
  });

  it("oauth2 throws a clear not-implemented error and never reaches the network", async () => {
    // oauth2 is deliberately unimplemented (needs token caching/refresh) —
    // explicit error, never an unauthed request. The throw inside request()'s
    // try surfaces via createBooking's status-0 path with the message intact.
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter({ authMechanism: "oauth2" });

    await expect(adapter.createBooking(createInput())).rejects.toThrow(
      /oauth2 auth mechanism not implemented/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unknown auth mechanism string fails loudly, not as an unauthenticated call", async () => {
    // A typo'd mechanism must never degrade into an unauthed request.
    const fetchMock = stubFetch(200, { id: 1 });
    const adapter = makeAdapter({ authMechanism: "magic_beans" as never });

    await expect(adapter.createBooking(createInput())).rejects.toThrow(
      /unknown auth mechanism "magic_beans"/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("request logging", () => {
  // GENERIC_MAPPED_QUIET is read per-request; save/restore so env never leaks
  // into other suites.
  const ORIGINAL_QUIET = process.env.GENERIC_MAPPED_QUIET;
  afterEach(() => {
    if (ORIGINAL_QUIET === undefined) delete process.env.GENERIC_MAPPED_QUIET;
    else process.env.GENERIC_MAPPED_QUIET = ORIGINAL_QUIET;
  });

  it("logs 2xx response bodies at info level by default (partner shape discovery)", async () => {
    // This log line is how a new partner's response shape gets learned.
    delete process.env.GENERIC_MAPPED_QUIET;
    stubFetch(200, { id: 5 });
    const adapter = makeAdapter();

    await adapter.createBooking(createInput());
    expect(logInfoSpy).toHaveBeenCalledWith(
      "generic_mapped 2xx response",
      expect.objectContaining({ status: 200, body: expect.stringContaining("5") }),
    );
  });

  it("suppresses the 2xx body log when GENERIC_MAPPED_QUIET=1", async () => {
    // Prod kill-switch: once shape is known, PII-bearing bodies stop logging.
    process.env.GENERIC_MAPPED_QUIET = "1";
    stubFetch(200, { id: 5 });
    const adapter = makeAdapter();

    await adapter.createBooking(createInput());
    expect(logInfoSpy).not.toHaveBeenCalledWith("generic_mapped 2xx response", expect.anything());
  });

  it("logs non-2xx responses with the request body for field-mismatch debugging", async () => {
    // quote/cancel/fetchPayment callers see only a boolean — this warn log is
    // the only place the partner's rejection body is visible.
    stubFetch(400, { error: "unknown field vehicleType" });
    const adapter = makeAdapter();

    await adapter.quote({ booking });
    expect(logWarnSpy).toHaveBeenCalledWith(
      "generic_mapped non-2xx response",
      expect.objectContaining({
        status: 400,
        body: expect.stringContaining("unknown field"),
        request_body: expect.stringContaining("Trafalgar Square"),
      }),
    );
  });
});
