import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ICabbiAdapter, resetWebhookListeners, registerWebhookSubscription, deleteWebhookSubscription } from "../icabbi";
import { ICABBI_WEBHOOK_EVENTS } from "@/lib/icabbi-webhook-events";
import type { CreateBookingInput, NormalisedBooking } from "@/lib/types";
import type { FeeSnapshot } from "@/db/schema";

/**
 * Real iCabbi adapter (src/adapters/icabbi.ts), against a stubbed global fetch.
 * The exact URL/method/headers/body assertions ARE the contract with iCabbi's
 * v2 API — they catch a wire change before a live tenant does. Complements
 * icabbi-normalise.test.ts (real-fixture inbound regression) and
 * adapter-contract.test.ts (interface floor). Covered: outbound HTTP
 * (create/cancel/payment), auth headers, base-URL resolution (per-partner >
 * env > default), the HTTP-200-with-error-envelope quirk, webhook listener
 * subscribe/teardown, timeouts, and the inbound shapes fixtures don't reach
 * (Segment properties, Karhoo envelope, synthetic create paths).
 */

const CREDS = {
  appKey: "AK-test",
  secretKey: "SK-test",
  webhookSecret: "wh-test",
};

const sampleBooking: NormalisedBooking = {
  originatorBookingExternalId: "ORIG-1",
  bookingType: "asap",
  channel: "app",
  pickup: { lat: 53.349, lng: -6.26, address: "1 Origin St" },
  dropoff: { lat: 53.421, lng: -6.27, address: "2 Dest Rd" },
  vehicleType: "standard",
  passengerCount: 1,
  passenger: { name: "Test Passenger", phone: "+353 1 000 0000" },
  raw: {},
};

const sampleFeeSnapshot: FeeSnapshot = {
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

function makeInput(booking: Partial<NormalisedBooking> = {}): CreateBookingInput {
  return {
    transitId: "00000000-0000-0000-0000-000000000abc",
    recipientPartnerId: "11111111-1111-1111-1111-111111111111",
    booking: { ...sampleBooking, ...booking },
    feeSnapshot: sampleFeeSnapshot,
  };
}

/** Stub global fetch with a vi.fn(); restored in afterEach via unstubAllGlobals. */
function stubFetch() {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Build a Response carrying a JSON body — what iCabbi actually returns. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Successful iCabbi envelope: real payload lives in `body`. */
function envelope(body: unknown, code: number | string = 200): Record<string, unknown> {
  return { version: "2", code, body };
}

function newAdapter(creds: Partial<typeof CREDS> & { apiBaseUrl?: string } = {}) {
  return new ICabbiAdapter("partner-1", { ...CREDS, ...creds });
}

// Tests pass with no env set and must not leak env they set (shared process).
const ORIGINAL_BASE_URL = process.env.ICABBI_API_BASE_URL;
const ORIGINAL_PREFIX = process.env.ICABBI_WEBHOOK_NAME_PREFIX;

beforeEach(() => {
  delete process.env.ICABBI_API_BASE_URL;
  delete process.env.ICABBI_WEBHOOK_NAME_PREFIX;
});

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.ICABBI_API_BASE_URL;
  else process.env.ICABBI_API_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_PREFIX === undefined) delete process.env.ICABBI_WEBHOOK_NAME_PREFIX;
  else process.env.ICABBI_WEBHOOK_NAME_PREFIX = ORIGINAL_PREFIX;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ICabbiAdapter — constructor credential guard", () => {
  it("throws when appKey is missing", () => {
    // Fail fast at construction — a half-saved-creds row mustn't be routable.
    expect(() => new ICabbiAdapter("p1", { ...CREDS, appKey: "" })).toThrow(/missing credentials/);
  });

  it("throws when secretKey is missing", () => {
    expect(() => new ICabbiAdapter("p1", { ...CREDS, secretKey: "" })).toThrow(/missing credentials/);
  });

  it("constructs with valid credentials and exposes key + partnerId", () => {
    // `key` must match partners.adapterKey ("icabbi") — registry relies on it.
    const a = newAdapter();
    expect(a.key).toBe("icabbi");
    expect(a.partnerId).toBe("partner-1");
  });
});

describe("ICabbiAdapter.createBooking — request construction", () => {
  it("POSTs to {base}/bookings/add with App-Key/Secret-Key auth headers", async () => {
    // Literal wire contract: path, method, two auth headers (no OAuth in v2).
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ trip_id: 42 })));

    await newAdapter().createBooking(makeInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.icabbi.com/v2/bookings/add");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "App-Key": "AK-test",
      "Secret-Key": "SK-test",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("sends a BookingSimpleCreate body: name, phone, address, destination, external_reference", async () => {
    // Body shape from iCabbi's Swagger BookingSimpleCreate; external_reference
    // is our addition for cross-side reconciliation.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter().createBooking(makeInput());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      name: "Test Passenger",
      phone: "+353 1 000 0000",
      address: { lat: 53.349, lng: -6.26, formatted: "1 Origin St" },
      destination: { lat: 53.421, lng: -6.27, formatted: "2 Dest Rd" },
      external_reference: "ORIG-1",
    });
  });

  it("omits `date` for ASAP bookings (iCabbi treats missing date as ASAP)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter().createBooking(makeInput({ bookingType: "asap" }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("date");
  });

  it("sends ISO-8601 `date` for prebook bookings with a scheduledFor", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter().createBooking(
      makeInput({ bookingType: "prebook", scheduledFor: "2026-07-01T10:30:00Z" }),
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.date).toBe("2026-07-01T10:30:00Z");
  });

  it("omits `date` when prebook has no scheduledFor (defensive: don't send undefined)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter().createBooking(makeInput({ bookingType: "prebook", scheduledFor: undefined }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("date");
  });
});

describe("ICabbiAdapter.createBooking — base URL resolution", () => {
  it("uses the production default when no override is configured", async () => {
    // No per-partner url, no env → https://api.icabbi.com/v2.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter().createBooking(makeInput());

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.icabbi.com/v2/bookings/add");
  });

  it("env ICABBI_API_BASE_URL overrides the default", async () => {
    process.env.ICABBI_API_BASE_URL = "https://envhost.example.com/v2";
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter().createBooking(makeInput());

    expect(fetchMock.mock.calls[0][0]).toBe("https://envhost.example.com/v2/bookings/add");
  });

  it("per-partner apiBaseUrl beats the env override (multi-cluster tenants)", async () => {
    // Tenants live on different clusters; one global env can't serve all →
    // per-partner config wins.
    process.env.ICABBI_API_BASE_URL = "https://envhost.example.com/v2";
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter({ apiBaseUrl: "https://1stagingapi.icabbi.com/1staging" }).createBooking(makeInput());

    expect(fetchMock.mock.calls[0][0]).toBe("https://1stagingapi.icabbi.com/1staging/bookings/add");
  });

  it("strips a trailing slash from the configured base so paths don't double-slash", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1 })));

    await newAdapter({ apiBaseUrl: "https://host.example.com/v2/" }).createBooking(makeInput());

    expect(fetchMock.mock.calls[0][0]).toBe("https://host.example.com/v2/bookings/add");
  });
});

describe("ICabbiAdapter.createBooking — response id extraction", () => {
  it("prefers perma_id over trip_id and id (stable id across re-dispatches)", async () => {
    // perma_id is the only id stable across re-dispatches — trip_id would make
    // a re-dispatch look like a new booking.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1, trip_id: 2, perma_id: 3 })));

    const r = await newAdapter().createBooking(makeInput());
    expect(r.externalId).toBe("3");
  });

  it("falls back through trip_id → booking_id → id when perma_id absent", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 1, booking_id: 9 })));

    const r = await newAdapter().createBooking(makeInput());
    expect(r.externalId).toBe("9");
  });

  it("finds the id nested under body.booking (alternate envelope layout)", async () => {
    // Spec doesn't pin the body shape — accept the id nested under `booking`
    // as well as top-level.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ booking: { trip_id: "T-77" } })));

    const r = await newAdapter().createBooking(makeInput());
    expect(r.externalId).toBe("T-77");
  });

  it("returns an ISO acceptedAt timestamp", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 5 })));

    const r = await newAdapter().createBooking(makeInput());
    expect(Number.isNaN(Date.parse(r.acceptedAt))).toBe(false);
  });

  it("throws a descriptive error when the 2xx response has no id anywhere", async () => {
    // A success with no id is untrackable — fail loudly, don't store a transit
    // with no external linkage.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ something_else: true })));

    await expect(newAdapter().createBooking(makeInput())).rejects.toThrow(/returned no id/);
  });

  it("throws when a nested booking object is present but carries no id field", async () => {
    // The nested-`booking` scan must exhaust cleanly — a blob with no id is
    // still untrackable.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ booking: { status: "NEW" } })));

    await expect(newAdapter().createBooking(makeInput())).rejects.toThrow(/returned no id/);
  });

  it("captures partnership coid linkage + track link when present in the response", async () => {
    // coid partnership protocol: a cross-tenant booking's linkage must be
    // persisted for reconciliation.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(
        envelope({
          booking: {
            id: 7,
            partnership_booking: {
              coid: 2661,
              client_id: 30092,
              server_name: "bounds",
              site_id: 51,
              track_my_taxi_link: "RJUNIL0X01.lc8.cab/w",
            },
          },
        }),
      ),
    );

    const r = await newAdapter().createBooking(makeInput());
    expect(r.partnership).toEqual({
      coid: "2661",
      clientId: "30092",
      serverName: "bounds",
      siteId: "51",
    });
    expect(r.trackMyTaxiLink).toBe("RJUNIL0X01.lc8.cab/w");
  });

  it("omits partnership/trackMyTaxiLink fields entirely for intra-tenant bookings", async () => {
    // No partnership_booking block → no empty keys (callers spread the result
    // straight into the transit row).
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 7 })));

    const r = await newAdapter().createBooking(makeInput());
    expect("partnership" in r).toBe(false);
    expect("trackMyTaxiLink" in r).toBe(false);
  });

  it("ignores an empty partnership_booking object (no keys extracted → undefined)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({ booking: { id: 7, partnership_booking: {} } })));

    const r = await newAdapter().createBooking(makeInput());
    expect("partnership" in r).toBe(false);
  });

  it("picks up track_my_taxi_link at the booking top level (outside partnership_booking)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(envelope({ booking: { id: 7, track_my_taxi_link: "abc.cab/w" } })),
    );

    const r = await newAdapter().createBooking(makeInput());
    expect(r.trackMyTaxiLink).toBe("abc.cab/w");
  });
});

describe("ICabbiAdapter — error envelope handling (the HTTP-200 quirk)", () => {
  it("treats HTTP 200 + in-envelope error code 401 as a failure with iCabbi's message", async () => {
    // iCabbi quirk: auth failures return HTTP 200 with the real status in the
    // envelope — checking only res.ok would mask them as "no id in response".
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 401, error: true, message: "Auth Credentials Invalid", info: { error_id: "e-123" } }),
    );

    await expect(newAdapter().createBooking(makeInput())).rejects.toThrow(
      /401 Auth Credentials Invalid \(iCabbi error_id=e-123\)/,
    );
  });

  it("treats `error: true` as failure even without a numeric code", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ error: true, message: "Something broke" }));

    await expect(newAdapter().createBooking(makeInput())).rejects.toThrow(/Something broke/);
  });

  it("accepts a string envelope code like '200' (only numeric codes are range-checked)", async () => {
    // Envelope `code` is number|string — string "200" mustn't read as an error.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ version: "2", code: "200", body: { id: 11 } }));

    const r = await newAdapter().createBooking(makeInput());
    expect(r.externalId).toBe("11");
  });

  it("surfaces the HTTP status + raw text for a non-2xx non-JSON response", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    await expect(newAdapter().createBooking(makeInput())).rejects.toThrow(/502 Bad Gateway/);
  });

  it("rejects on a 2xx response with a non-JSON body (no envelope to unwrap)", async () => {
    // FLAG (actual behaviour): a 200 with non-JSON text leaves json null, so
    // createBooking reads `.body` off null → a TypeError, not a descriptive
    // error. Locks in "it rejects"; the message could be friendlier.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("<html>gateway page</html>", { status: 200 }));

    await expect(newAdapter().createBooking(makeInput())).rejects.toThrow();
  });
});

describe("ICabbiAdapter.cancelBooking", () => {
  it("POSTs to /bookings/cancel/{trip_id} with the reason in the body", async () => {
    // Cancel contract: id in the path (per spec), reason in the body
    // (undocumented but kept for iCabbi's audit trail).
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({})));

    await newAdapter().cancelBooking({ externalId: "12345", reason: "passenger no-show" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.icabbi.com/v2/bookings/cancel/12345");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "passenger no-show" });
  });

  it("URL-encodes the external id so a hostile id can't change the request path", async () => {
    // Path-injection guard: an id with "/" or "?" can't redirect the cancel.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(envelope({})));

    await newAdapter().cancelBooking({ externalId: "a/b?c", reason: "r" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.icabbi.com/v2/bookings/cancel/a%2Fb%3Fc");
  });

  it("propagates the envelope error when iCabbi rejects the cancel", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ code: 404, error: true, message: "Booking not found" }));

    await expect(newAdapter().cancelBooking({ externalId: "9", reason: "r" })).rejects.toThrow(
      /404 Booking not found/,
    );
  });
});

describe("ICabbiAdapter.fetchBookingPayment", () => {
  it("GETs /bookings/{id} with auth headers and converts GBP to pence", async () => {
    // Reconciliation needs exact pence — float GBP must round, never truncate.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({
        body: {
          booking: {
            payment: { total: 12.345, fee: 1.0, processing_fee: 0.5, status: "PROCESSED", fixed: 1, tariff_id: 7 },
          },
        },
      }),
    );

    const r = await newAdapter().fetchBookingPayment("B-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.icabbi.com/v2/bookings/B-1");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ "App-Key": "AK-test", "Secret-Key": "SK-test" });
    expect(r).toEqual({
      totalPence: 1235, // 12.345 rounds up
      status: "PROCESSED",
      feePence: 100,
      processingFeePence: 50,
      fixedFare: true,
      tariffId: "7",
    });
  });

  it("falls back from payment.total to payment.cost when total is absent", async () => {
    // Some tenants only populate `cost`.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ body: { booking: { payment: { cost: 8.4 } } } }));

    const r = await newAdapter().fetchBookingPayment("B-1");
    expect(r?.totalPence).toBe(840);
  });

  it("omits tariffId when tariff_id is 0 (iCabbi uses 0 for 'no tariff')", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ body: { booking: { payment: { total: 5, tariff_id: 0, fixed: 0 } } } }),
    );

    const r = await newAdapter().fetchBookingPayment("B-1");
    expect(r?.tariffId).toBeUndefined();
    expect(r?.fixedFare).toBe(false);
  });

  it("omits status when payment.status is not a string", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ body: { booking: { payment: { total: 5, status: 7 } } } }));

    const r = await newAdapter().fetchBookingPayment("B-1");
    expect(r?.status).toBeUndefined();
  });

  it("defaults all amounts to 0 when the booking has no payment block", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ body: { booking: {} } }));

    const r = await newAdapter().fetchBookingPayment("B-1");
    expect(r).toEqual({
      totalPence: 0,
      status: undefined,
      feePence: 0,
      processingFeePence: 0,
      fixedFare: false,
      tariffId: undefined,
    });
  });

  it("returns null on a non-2xx response (reconciliation treats it as 'unknown')", async () => {
    // Payment fetch is best-effort — a 404/500 degrades to null, never throws
    // into the reconciliation loop.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

    expect(await newAdapter().fetchBookingPayment("B-1")).toBeNull();
  });

  it("returns null when the response carries no booking object", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ body: {} }));

    expect(await newAdapter().fetchBookingPayment("B-1")).toBeNull();
  });

  it("returns null when fetch itself rejects (network error)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await newAdapter().fetchBookingPayment("B-1")).toBeNull();
  });

  it("URL-encodes the external id in the GET path", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("x", { status: 404 }));

    await newAdapter().fetchBookingPayment("a/b");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.icabbi.com/v2/bookings/a%2Fb");
  });
});

describe("resetWebhookListeners — create phase wire contract", () => {
  const ARGS = {
    appKey: "AK",
    secretKey: "SK",
    callbackUrl: "https://exchange.example.com/api/webhooks/ingest/p1?token=tok",
    existingProviderIds: [] as string[],
  };

  it("POSTs /eventlisteners/create with the exact iCabbi body shape per event", async () => {
    // Confirmed-against-staging: one create per event with
    // { name, event, url, format:"json", template:"#json" }. Any field change
    // silently breaks registration iCabbi-side.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ eventlistener: { id: 101 } }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:completed"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.icabbi.com/v2/eventlisteners/create");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "App-Key": "AK", "Secret-Key": "SK" });
    expect(JSON.parse(init.body as string)).toEqual({
      name: "exchange_booking_completed", // default "exchange" prefix, colons→underscores
      event: "booking:completed",
      url: ARGS.callbackUrl,
      format: "json",
      template: "#json",
    });
    expect(result.created).toEqual([
      { providerId: "101", event: "booking:completed", name: "exchange_booking_completed" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("attaches an abort signal so a hung iCabbi endpoint can't stall the connect flow", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ eventlistener: { id: 1 } }));

    await resetWebhookListeners({ ...ARGS, events: ["booking:completed"] });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("registers one listener per event — all 13 by default", async () => {
    // Default event set is the full ICABBI_WEBHOOK_EVENTS catalogue — fewer
    // would silently miss lifecycle updates.
    const fetchMock = stubFetch();
    let nextId = 1;
    fetchMock.mockImplementation(async () => jsonResponse({ eventlistener: { id: nextId++ } }));

    const result = await resetWebhookListeners(ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(ICABBI_WEBHOOK_EVENTS.length);
    expect(result.created).toHaveLength(13);
    // Every canonical event got exactly one listener.
    expect(new Set(result.created.map((c) => c.event))).toEqual(new Set(ICABBI_WEBHOOK_EVENTS));
  });

  it("accepts a top-level { id } response shape (future-API tolerance)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ id: 55 }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:arrived"] });
    expect(result.created[0]?.providerId).toBe("55");
  });

  it("records an error when a 2xx create response carries no listener id", async () => {
    // A create we can't later delete is worse than a failed one — without the
    // id the listener is orphaned on iCabbi forever.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:edit"] });
    expect(result.created).toEqual([]);
    expect(result.errors[0]).toMatch(/create booking:edit: 200 no eventlistener.id/);
  });

  it("records an error (not throw) when iCabbi returns a non-2xx create", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:noshow"] });
    expect(result.created).toEqual([]);
    expect(result.errors[0]).toMatch(/create booking:noshow: 403 forbidden/);
  });

  it("treats a 2xx non-JSON body as a missing id, not a crash", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:allocate"] });
    expect(result.errors[0]).toMatch(/no eventlistener.id/);
  });

  it("maps an AbortSignal timeout to a status-0 'timed out' error entry", async () => {
    // 10s AbortSignal.timeout → TimeoutError; reject synthetically, no real wait.
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:completed"] });
    expect(result.errors[0]).toMatch(/create booking:completed: 0 timed out after 10000ms/);
  });

  it("maps a generic network error to a status-0 error entry with the message", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new Error("ENOTFOUND api.icabbi.com"));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:completed"] });
    expect(result.errors[0]).toMatch(/create booking:completed: 0 ENOTFOUND/);
  });

  it("keeps partial successes when only some creates fail (caller persists the good ones)", async () => {
    // Keep-partials: the caller persists whatever succeeded and surfaces the
    // errors in the UI.
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.event === "booking:completed") return jsonResponse({ eventlistener: { id: 9 } });
      return new Response("boom", { status: 500 });
    });

    const result = await resetWebhookListeners({
      ...ARGS,
      events: ["booking:completed", "booking:arrived"],
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.event).toBe("booking:completed");
    expect(result.errors).toHaveLength(1);
  });

  it("honours the ICABBI_WEBHOOK_NAME_PREFIX env in listener names", async () => {
    // Multi-tenant guard: staging + prod on the same tenant mustn't collide
    // on listener names.
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "staging2";
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ eventlistener: { id: 1 } }));

    const result = await resetWebhookListeners({ ...ARGS, events: ["booking:completed"] });
    expect(result.created[0]?.name).toBe("staging2_booking_completed");
  });
});

describe("resetWebhookListeners — delete phase", () => {
  const ARGS = {
    appKey: "AK",
    secretKey: "SK",
    callbackUrl: "https://exchange.example.com/cb?token=t",
    apiBaseUrl: "https://staging.example.com/api",
    events: [] as const,
  };

  it("POSTs /eventlisteners/delete/{id} for each existing listener before creating", async () => {
    // Reset = delete-all then create-all; without the delete phase each reset
    // duplicates listeners iCabbi-side.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({}));

    const result = await resetWebhookListeners({ ...ARGS, existingProviderIds: ["11", "22"] });

    const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual([
      "https://staging.example.com/api/eventlisteners/delete/11",
      "https://staging.example.com/api/eventlisteners/delete/22",
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "App-Key": "AK", "Secret-Key": "SK" },
    });
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it("counts a 404 delete as success (listener already gone — desired end state)", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    const result = await resetWebhookListeners({ ...ARGS, existingProviderIds: ["gone"] });
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("collects a non-404 delete failure as an error but does NOT block creation", async () => {
    // Best-effort delete: one stuck listener can't block re-registering the
    // full event set.
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/delete/")) return new Response("denied", { status: 403 });
      return jsonResponse({ eventlistener: { id: 1 } });
    });

    const result = await resetWebhookListeners({
      ...ARGS,
      existingProviderIds: ["stuck"],
      events: ["booking:completed"],
    });
    expect(result.deleted).toBe(0);
    expect(result.errors[0]).toMatch(/delete stuck: 403 denied/);
    expect(result.created).toHaveLength(1); // create phase still ran
  });

  it("records a network-level delete failure with status 0", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const result = await resetWebhookListeners({ ...ARGS, existingProviderIds: ["x1"] });
    expect(result.deleted).toBe(0);
    expect(result.errors[0]).toMatch(/delete x1: 0 socket hang up/);
  });

  it("URL-encodes provider ids in the delete path", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({}));

    await resetWebhookListeners({ ...ARGS, existingProviderIds: ["a/b"] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://staging.example.com/api/eventlisteners/delete/a%2Fb");
  });
});

describe("deprecated webhook shims", () => {
  it("registerWebhookSubscription always fails with 410 pointing at the replacement", async () => {
    // The shim never hits the network (/webhooks/register doesn't exist) — a
    // 410 with migration guidance is the whole contract.
    const fetchMock = stubFetch();

    const r = await registerWebhookSubscription({
      appKey: "AK",
      secretKey: "SK",
      url: "https://cb.example.com",
      sharedSecret: "s",
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(410);
    expect(r.message).toMatch(/resetWebhookListeners/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deleteWebhookSubscription deletes a legacy single id via /eventlisteners/delete", async () => {
    // Transition path: partners onboarded under the old webhookSubscriptionId
    // shape still need a working disconnect.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({}));

    const r = await deleteWebhookSubscription({
      appKey: "AK",
      secretKey: "SK",
      subscriptionId: "legacy-9",
      apiBaseUrl: "https://legacy.example.com/v2/",
    });

    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://legacy.example.com/v2/eventlisteners/delete/legacy-9");
  });
});

// normaliseInboundWebhook — Segment-style "properties" shape (iCabbi's
// confirmed outbound format; not covered by the fixture tests).
describe("normaliseInboundWebhook — iCabbi properties shape (Segment-style)", () => {
  const adapter = newAdapter();

  it("maps an UPPER_SNAKE iCabbi status and carries the detail bundle", async () => {
    // The staging COID 1102 tenant sends this exact shape. The detail bundle
    // feeds the timeline + driver panel — assert every promised field.
    const r = await adapter.normaliseInboundWebhook({
      userId: "+447700900000",
      event: "booking:driver_designate",
      timestamp: "2026-06-10T09:00:00Z",
      properties: {
        booking_id: "B-100",
        status: "ASSIGNED",
        driver_name: "Jane Mary Doe",
        driver_phone: "+447700900001",
        vehicle_reg: "AB12 CDE",
        eta: "5",
        pickup_address: "1 Pickup St",
        destination_address: "2 Dropoff Rd",
      },
    });

    expect(r).toEqual({
      kind: "status",
      recipientBookingExternalId: "B-100",
      newStatus: "driver_assigned",
      detail: {
        icabbi_status: "ASSIGNED",
        event: "booking:driver_designate",
        timestamp: "2026-06-10T09:00:00Z",
        user_id: "+447700900000",
        driver: {
          first_name: "Jane",
          last_name: "Mary Doe", // everything after the first space
          phone_number: "+447700900001",
          license_number: null,
        },
        vehicle_license_plate: "AB12 CDE",
        eta_minutes: 5,
        pickup_address: "1 Pickup St",
        destination_address: "2 Dropoff Rd",
      },
    });
  });

  it("falls back to canonical BDD-spec status names when the code map misses", async () => {
    // "Passenger On Board" isn't UPPER_SNAKE — mapCanonicalStatus must catch
    // the human-readable form so real updates aren't dropped.
    const r = await adapter.normaliseInboundWebhook({
      properties: { booking_id: "B-1", status: "Passenger On Board" },
    });
    expect(r?.kind).toBe("status");
    if (r?.kind !== "status") return;
    expect(r.newStatus).toBe("on_board");
  });

  // Full canonical-name vocabulary — each row is a distinct mapCanonicalStatus
  // branch a typo'd refactor could drop.
  it.each([
    ["Accepted", "accepted"],
    ["Rejected", "no_match"],
    ["Driver Assigned", "driver_assigned"],
    ["Driver Arrived", "driver_arrived"],
    ["driver-en-route", "en_route"], // dashes/underscores normalised to spaces
    ["enroute", "en_route"],
    ["In Progress", "on_board"],
    // Separator variants: the mapper collapses spaces/underscores/dashes, so
    // codes that just miss UPPER_SNAKE (trailing separator) still resolve.
    ["Accepted-", "accepted"],
    ["Completed_", "completed"],
    ["Canceled_", "cancelled"], // US spelling accepted
    ["Failed-", "failed"],
  ])("canonical status %s → %s", async (raw, expected) => {
    const r = await adapter.normaliseInboundWebhook({
      properties: { booking_id: "B-1", status: raw },
    });
    if (r?.kind !== "status") throw new Error("expected status");
    expect(r.newStatus).toBe(expected);
  });

  it("returns null + warns on an unrecognised status (skip, don't coerce)", async () => {
    // Coercing an unknown status to a wrong state is worse than dropping it —
    // the route handler 200-acks nulls.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await adapter.normaliseInboundWebhook({
      properties: { booking_id: "B-1", status: "TELEPORTING" },
    });
    expect(r).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("TELEPORTING"));
  });

  it("returns null + warns when there is no booking_id to act on", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await adapter.normaliseInboundWebhook({
      event: "booking:completed",
      properties: { status: "COMPLETED" },
    });
    expect(r).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no booking_id"));
  });

  it("detects the template-not-substituted failure mode (#placeholders) and logs loudly", async () => {
    // Real incident (2026-06-08): iCabbi shipped the raw template with
    // #placeholders. ≥50% placeholder values short-circuit to null + loud error.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await adapter.normaliseInboundWebhook({
      properties: { booking_id: "#booking_id", status: "#booking_status" },
    });
    expect(r).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("TEMPLATE-NOT-SUBSTITUTED"));
  });

  it("does NOT trip the placeholder detector when under half the values are placeholders", async () => {
    // A legit address can start with '#' ("#1 High St") — only a majority of
    // placeholder-looking values means template failure.
    const r = await adapter.normaliseInboundWebhook({
      properties: {
        booking_id: "B-2",
        status: "COMPLETED",
        pickup_address: "#1 High St", // 1 of 3 string values
      },
    });
    expect(r?.kind).toBe("status");
  });

  it("treats a single-word driver_name as first name with empty last name", async () => {
    const r = await adapter.normaliseInboundWebhook({
      properties: { booking_id: "B-3", status: "ASSIGNED", driver_name: "Cher" },
    });
    if (r?.kind !== "status") throw new Error("expected status");
    expect(r.detail?.driver).toMatchObject({ first_name: "Cher", last_name: "" });
  });
});

describe("normaliseInboundWebhook — Karhoo envelope (iCabbi-as-Karhoo)", () => {
  const adapter = newAdapter();

  it("parses TripStatus with STRINGIFIED data into a status update", async () => {
    // Karhoo's `data` is stringified JSON — forgetting the inner JSON.parse is
    // the classic regression this locks out.
    const r = await adapter.normaliseInboundWebhook({
      id: "evt-1",
      event_type: "TripStatus",
      sent_at: "2026-06-10T10:00:00Z",
      data: JSON.stringify({ trip_id: "T-1", status: "POB", state_details: "with passenger" }),
    });

    expect(r).toEqual({
      kind: "status",
      recipientBookingExternalId: "T-1",
      newStatus: "on_board",
      detail: {
        karhoo_status: "POB",
        state_details: "with passenger",
        envelope_id: "evt-1",
        sent_at: "2026-06-10T10:00:00Z",
      },
    });
  });

  // Karhoo vocab differs from iCabbi's codes — every mapKarhooTripStatus
  // branch, incl. all three cancel variants.
  it.each([
    ["REQUESTED", "pushed"],
    ["CONFIRMED", "accepted"],
    ["ARRIVED", "driver_arrived"],
    ["DRIVER_EN_ROUTE", "en_route"],
    ["COMPLETED", "completed"],
    ["DRIVER_CANCELLED", "cancelled"],
    ["BOOKER_CANCELLED", "cancelled"],
    ["KARHOO_CANCELLED", "cancelled"],
    ["NO_DRIVERS_AVAILABLE", "failed"],
    ["FAILED", "failed"],
    ["SOMETHING_NEW", "error_other"], // unknown → flagged, not dropped
  ])("Karhoo TripStatus %s → %s", async (karhoo, expected) => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "TripStatus",
      data: JSON.stringify({ trip_id: "T-2", status: karhoo }),
    });
    if (r?.kind !== "status") throw new Error("expected status");
    expect(r.newStatus).toBe(expected);
  });

  it("accepts `data` already decoded as an object (defensive both-shapes handling)", async () => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "TripStatus",
      data: { trip_id: "T-3", status: "COMPLETED" },
    });
    expect(r?.kind).toBe("status");
  });

  it("returns null when `data` is malformed JSON (un-parseable event is un-actionable)", async () => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "TripStatus",
      data: "{not json",
    });
    expect(r).toBeNull();
  });

  it("returns null for TripStatus missing trip_id or status", async () => {
    expect(
      await adapter.normaliseInboundWebhook({ event_type: "TripStatus", data: JSON.stringify({ status: "POB" }) }),
    ).toBeNull();
    expect(
      await adapter.normaliseInboundWebhook({ event_type: "TripStatus", data: JSON.stringify({ trip_id: "T" }) }),
    ).toBeNull();
  });

  it("parses DriverDetails into a driver_assigned update with vehicle detail", async () => {
    // DriverDetails is the only Karhoo event with the vehicle bundle — the
    // driver panel renders straight from this detail.
    const r = await adapter.normaliseInboundWebhook({
      id: "evt-9",
      event_type: "DriverDetails",
      sent_at: "2026-06-10T10:05:00Z",
      data: JSON.stringify({
        trip_id: "T-4",
        driver: { first_name: "Sam" },
        vehicle_license_plate: "XY99 ZZZ",
        make: "Toyota",
        model: "Prius",
        colour: "Silver",
      }),
    });

    expect(r?.kind).toBe("status");
    if (r?.kind !== "status") return;
    expect(r.newStatus).toBe("driver_assigned");
    expect(r.recipientBookingExternalId).toBe("T-4");
    expect(r.detail).toMatchObject({
      driver: { first_name: "Sam" },
      vehicle_license_plate: "XY99 ZZZ",
      make: "Toyota",
      model: "Prius",
      colour: "Silver",
      envelope_id: "evt-9",
    });
  });

  it("returns null for DriverDetails without a trip_id", async () => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "DriverDetails",
      data: JSON.stringify({ driver: { first_name: "Sam" } }),
    });
    expect(r).toBeNull();
  });

  it("deliberately skips FinalFareReleased (billing event, not a lifecycle change)", async () => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "FinalFareReleased",
      data: JSON.stringify({ trip_id: "T-5", fare: 1234 }),
    });
    expect(r).toBeNull();
  });

  it("deliberately skips DriverPositionChanged (too noisy for our model)", async () => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "DriverPositionChanged",
      data: JSON.stringify({ trip_id: "T-6", lat: 1, lng: 2 }),
    });
    expect(r).toBeNull();
  });

  it("returns null for an unknown event type so the route can 200-ack (no infinite retries)", async () => {
    const r = await adapter.normaliseInboundWebhook({
      event_type: "SomethingNovel",
      data: JSON.stringify({}),
    });
    expect(r).toBeNull();
  });
});

// normaliseInboundWebhook — direct iCabbi booking shapes the fixtures don't
// reach (synthetic; fixtures cover the body.booking case).

/** Minimal direct-iCabbi booking object that passes the isLikelyBooking sniff. */
function directBooking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "UNMAPPED_STATE", // not in the status map, not ignored → create path
    id: 8001,
    name: "Alice Smith",
    phone: "+447700900123",
    address: { lat: 51.5, lng: -0.1, formatted: "1 Pickup Lane", postcode: "E1 6AN" },
    destination: { lat: 51.6, lng: -0.2, formatted: "2 Dropoff Way" },
    ...overrides,
  };
}

describe("normaliseInboundWebhook — direct booking shape detection", () => {
  const adapter = newAdapter();

  it("recognises the booking when the payload itself IS the booking object", async () => {
    // iCabbi sometimes delivers the bare booking, not the {body:{booking}}
    // envelope — the sniffer handles both.
    const r = await adapter.normaliseInboundWebhook(directBooking({ status: "COMPLETED" }));
    expect(r).toEqual(expect.objectContaining({ kind: "status", newStatus: "completed" }));
  });

  it("recognises a booking wrapped under `data` as a plain object", async () => {
    const r = await adapter.normaliseInboundWebhook({
      data: directBooking({ status: "ARRIVED", perma_id: 7007 }),
    });
    expect(r).toEqual(
      expect.objectContaining({
        kind: "status",
        newStatus: "driver_arrived",
        recipientBookingExternalId: "7007",
      }),
    );
  });

  it("includes the driver+vehicle bundle ONLY on driver_assigned/driver_arrived", async () => {
    // PII minimisation: driver details surface on assignment events only (the
    // COMPLETED case is in the fixture test).
    const r = await adapter.normaliseInboundWebhook(
      directBooking({
        status: "ASSIGNED",
        driver: {
          first_name: "Bob",
          last_name: "Driver",
          mobile: "+447700900999",
          vehicle: { make: "Skoda", model: "Octavia", colour: "Black", reg: "BD70 XYZ" },
        },
      }),
    );

    if (r?.kind !== "status") throw new Error("expected status");
    expect(r.newStatus).toBe("driver_assigned");
    expect(r.detail?.driver).toEqual({
      first_name: "Bob",
      last_name: "Driver",
      phone_number: "+447700900999",
      make: "Skoda",
      model: "Octavia",
      colour: "Black",
      reg: "BD70 XYZ",
    });
  });

  it("falls back to vehicle.plate when vehicle.reg is absent", async () => {
    const r = await adapter.normaliseInboundWebhook(
      directBooking({
        status: "ASSIGNED",
        driver: { first_name: "Bob", vehicle: { plate: "PL4 TE" } },
      }),
    );
    if (r?.kind !== "status") throw new Error("expected status");
    expect((r.detail?.driver as Record<string, unknown>)?.reg).toBe("PL4 TE");
  });

  it("omits driver detail when the driver object has no first_name (not actually assigned)", async () => {
    const r = await adapter.normaliseInboundWebhook(
      directBooking({ status: "ASSIGNED", driver: { vehicle: { reg: "X" } } }),
    );
    if (r?.kind !== "status") throw new Error("expected status");
    expect(r.detail?.driver).toBeUndefined();
  });

  it("returns null for a status event whose booking carries no usable id", async () => {
    const r = await adapter.normaliseInboundWebhook(
      directBooking({ status: "COMPLETED", id: undefined }),
    );
    expect(r).toBeNull();
  });

  it("returns null for ignored meta-statuses like TRANSFERRED on a bare booking", async () => {
    // TRANSFERRED is a demand-side meta-state — emitting a status update would
    // corrupt the recipient-side lifecycle.
    const r = await adapter.normaliseInboundWebhook(directBooking({ status: "TRANSFERRED" }));
    expect(r).toBeNull();
  });
});

describe("normaliseInboundWebhook — direct booking CREATE normalisation", () => {
  const adapter = newAdapter();

  it("maps a rich iCabbi booking to a full NormalisedBooking (every field group)", async () => {
    // The one test pinning the complete field mapping (ids, geo, vias filter,
    // payment, vehicle, channel, account/tariff/zone). A drop = data silently
    // lost on every inbound booking.
    const payload = directBooking({
      perma_id: 555,
      booking_id: 666, // perma_id must win
      prebooked: 1,
      pickup_date: "2026-07-01T10:00:00Z",
      vias: [
        { type: "PICKUP", lat: 51.5, lng: -0.1, formatted: "1 Pickup Lane" }, // stripped
        { type: "VIA", lat: 51.55, lng: -0.15, formatted: "Mid Stop", name: "Bob", phone: "+44123" },
        "not-an-object", // ignored, not crashed on
      ],
      payment: { passengers: 3, cost: 12.5, tariff_id: "4", fixed: 1 },
      zone: { ref: "Z-EAST" },
      vehicle_type: "R7",
      vehicle_group: "Taxi",
      source: "APP",
      payment_type: "CARD",
      notes: "ring bell",
      instructions: "back gate",
      driver_comment: "VIP",
      flight_number: "BA123",
      destination_flight_number: "EI456",
      attributegroup_id: 9,
      account_id: 42,
      priority: 2,
    });

    const r = await adapter.normaliseInboundWebhook(payload);
    if (r?.kind !== "create") throw new Error("expected create");

    expect(r.booking).toMatchObject({
      originatorBookingExternalId: "555", // perma_id preferred over booking_id/id
      bookingType: "prebook",
      scheduledFor: "2026-07-01T10:00:00Z",
      channel: "app",
      vehicleType: "mpv", // R7 = 7-seater → mpv
      passengerCount: 3,
      fareEstimatePence: 1250,
      passenger: { name: "Alice Smith", phone: "+447700900123" },
      notes: "ring bell",
      instructions: "back gate",
      driverComment: "VIP",
      paymentType: "card",
      source: "APP",
      flightNumber: "BA123",
      destinationFlightNumber: "EI456",
      nativeVehicleType: "R7",
      vehicleGroup: "Taxi",
      attributeGroupId: "9",
      accountId: "42",
      tariffId: "4",
      fixedFare: true,
      zoneId: "Z-EAST",
      priority: 2,
    });
    expect(r.booking.pickup).toEqual({
      lat: 51.5,
      lng: -0.1,
      address: "1 Pickup Lane",
      postcode: "E1 6AN",
      contactName: "Alice Smith",
      contactPhone: "+447700900123",
    });
    // PICKUP via stripped, garbage skipped → only the real stop.
    expect(r.booking.vias).toEqual([
      {
        lat: 51.55,
        lng: -0.15,
        address: "Mid Stop",
        postcode: undefined,
        contactName: "Bob",
        contactPhone: "+44123",
      },
    ]);
    // The full original payload is retained for audit.
    expect(r.booking.raw).toBe(payload);
  });

  it("treats prebooked=0 as ASAP and drops any scheduled date", async () => {
    // An ASAP booking with a stale pickup_date mustn't become a prebook.
    const r = await adapter.normaliseInboundWebhook(
      directBooking({ prebooked: 0, pickup_date: "2026-07-01T10:00:00Z" }),
    );
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.bookingType).toBe("asap");
    expect(r.booking.scheduledFor).toBeUndefined();
  });

  it("reads coordinates from actual_lat/actual_lng when lat/lng are absent", async () => {
    const r = await adapter.normaliseInboundWebhook(
      directBooking({
        destination: { actual_lat: 51.7, actual_lng: -0.3, formatted: "Actuals" },
      }),
    );
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.dropoff).toMatchObject({ lat: 51.7, lng: -0.3, address: "Actuals" });
  });

  it("returns null when pickup coordinates are missing/non-numeric (unroutable booking)", async () => {
    const r = await adapter.normaliseInboundWebhook(
      directBooking({ address: { lat: "not-a-number", lng: -0.1, formatted: "X" } }),
    );
    expect(r).toBeNull();
  });

  it("returns null when the booking has no id under any known key", async () => {
    const r = await adapter.normaliseInboundWebhook(directBooking({ id: undefined }));
    expect(r).toBeNull();
  });

  it("falls back to route.estimate_fare when payment.cost is missing", async () => {
    const r = await adapter.normaliseInboundWebhook(
      directBooking({ route: { estimate_fare: 9.99 } }),
    );
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.fareEstimatePence).toBe(999);
  });

  it("leaves fareEstimatePence undefined when no fare is known (0 is not a fare)", async () => {
    const r = await adapter.normaliseInboundWebhook(directBooking());
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.fareEstimatePence).toBeUndefined();
  });

  it("omits accountId when account_id is 0 (iCabbi's 'no account' sentinel)", async () => {
    const r = await adapter.normaliseInboundWebhook(directBooking({ account_id: 0 }));
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.accountId).toBeUndefined();
  });

  it("drops non-string/non-number values in string fields instead of stringifying objects", async () => {
    // If iCabbi sends an object/array where a string belongs → undefined, not
    // "[object Object]" leaking into driver-facing notes.
    const r = await adapter.normaliseInboundWebhook(
      directBooking({ notes: { unexpected: "object" }, instructions: ["array"] }),
    );
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.notes).toBeUndefined();
    expect(r.booking.instructions).toBeUndefined();
  });

  it("falls back to booking.zone_id when zone.ref is absent", async () => {
    const r = await adapter.normaliseInboundWebhook(directBooking({ zone_id: "Z-9" }));
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.zoneId).toBe("Z-9");
  });

  // Vehicle taxonomy — group keywords beat native codes; R<seats> buckets by
  // capacity. Each row a mapNativeVehicleType branch.
  it.each([
    [{ vehicle_group: "Executive Cars" }, "exec"],
    [{ vehicle_group: "Wheelchair Access" }, "wav"],
    [{ vehicle_group: "MPV" }, "mpv"],
    [{ vehicle_group: "6 Seater" }, "mpv"], // capacity keyword in group name
    [{ vehicle_type: "R7", vehicle_group: "Taxi" }, "mpv"], // 7-seater code
    [{ vehicle_type: "R4", vehicle_group: "Taxi" }, "standard"],
    [{ vehicle_type: "EXEC1" }, "exec"],
    [{ vehicle_type: "WAV2" }, "wav"],
    [{ vehicle_type: "RX" }, "standard"], // R-code with non-numeric seats → default
    [{}, "standard"], // nothing known → default
  ])("vehicle mapping %j → %s", async (fields, expected) => {
    const r = await adapter.normaliseInboundWebhook(directBooking(fields));
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.vehicleType).toBe(expected);
  });

  // Channel mapping from iCabbi's source field.
  it.each([
    ["APP", "app"],
    ["WEB", "web"],
    ["PHONE", "phone"],
    ["PHONE_CALL", "phone"],
    ["DISPATCH", "api"],
    [undefined, "api"], // unknown/missing → api
  ])("source %s → channel %s", async (source, expected) => {
    const r = await adapter.normaliseInboundWebhook(directBooking({ source }));
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.channel).toBe(expected);
  });

  // Payment type mapping including the aliases (CREDIT_CARD, INVOICE).
  it.each([
    ["CASH", "cash"],
    ["CARD", "card"],
    ["CREDIT_CARD", "card"],
    ["ACCOUNT", "account"],
    ["INVOICE", "account"],
    ["VOUCHER", "voucher"],
    ["CRYPTO", undefined], // unknown → undefined, never a wrong bucket
  ])("payment_type %s → %s", async (paymentType, expected) => {
    const r = await adapter.normaliseInboundWebhook(directBooking({ payment_type: paymentType }));
    if (r?.kind !== "create") throw new Error("expected create");
    expect(r.booking.paymentType).toBe(expected);
  });
});
