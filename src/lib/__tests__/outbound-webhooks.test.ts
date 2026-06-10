import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

/**
 * Outbound webhook delivery (sendOutboundEvent) — signing + idempotency.
 * Integrity properties partners depend on:
 *   - HMAC-SHA512 checksum recomputed in-test for an exact match
 *   - deterministic event ids (sha256 of eventKey / payload fingerprint)
 *     so partners dedupe across retries
 *   - stableStringify is key-order independent (equal payloads → same id)
 *   - the webhook secret never leaks into request, record, or result
 *   - failure paths (non-2xx, network error, 5s timeout) return structured
 *     and queue the first retry +30s — never throw
 * db is mocked; fetch is stubbed; @/lib/crypto is the REAL module (one test
 * stores encrypted creds to prove the secret is decrypted before signing).
 */

// Mocked db. partnerRows feeds the lookup; insertCalls captures every
// delivery record; throwOnInsert simulates the swallowed unique violation.
const dbController: {
  partnerRows: Array<Record<string, unknown>>;
  insertCalls: Array<Record<string, unknown>>;
  throwOnInsert: boolean;
} = { partnerRows: [], insertCalls: [], throwOnInsert: false };

vi.mock("@/db/client", () => ({
  db: {
    // Mirrors the module's chain: db.select().from(partners).where(...) → rows
    select: () => {
      const chain = {
        from: () => chain,
        where: async () => dbController.partnerRows,
      };
      return chain;
    },
    // Mirrors: db.insert(webhookDeliveries).values({...})
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        if (dbController.throwOnInsert) {
          throw new Error("duplicate key value violates unique constraint");
        }
        dbController.insertCalls.push(v);
      },
    }),
  },
}));

import {
  sendOutboundEvent,
  RETRY_INTERVALS_MS,
  MAX_DELIVERY_ATTEMPTS,
  type OutboundEventPayload,
} from "@/lib/outbound-webhooks";
import { encryptCredentials } from "@/lib/crypto";

const SECRET = "whsec_test_super_secret_value";
const URL = "https://partner.example.com/webhooks/exchange";
const PARTNER_ID = "ptr_originator_1";

// Frozen clock so envelope timestamps assert exactly.
const NOW = new Date("2026-06-10T12:00:00.000Z");

/** A minimal partner row with a webhook destination + plaintext secret. */
function partnerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PARTNER_ID,
    name: "Demand Fleet",
    webhookUrl: URL,
    credentials: { webhookSecret: SECRET },
    ...overrides,
  };
}

function basePayload(extra: Record<string, unknown> = {}): OutboundEventPayload {
  return {
    originatorBookingExternalId: "EXT-1",
    transitId: "tr_1",
    ...extra,
  };
}

/** Build a fetch mock resolving to a Response-ish object. */
function fetchResponding(status: number, ok: boolean, body = "") {
  return vi.fn().mockResolvedValue({ ok, status, text: async () => body });
}

beforeEach(() => {
  dbController.partnerRows = [];
  dbController.insertCalls = [];
  dbController.throwOnInsert = false;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendOutboundEvent — preconditions (no fetch, no insert)", () => {
  it("returns no_partner when the originator id matches no row", async () => {
    // Unknown partner short-circuits: no HTTP, no delivery record.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);

    const r = await sendOutboundEvent("ptr_missing", "transit.rerouted", basePayload());
    expect(r).toEqual({ ok: false, reason: "no_partner" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbController.insertCalls).toHaveLength(0);
  });

  it("returns no_webhook_url when the partner has no destination configured", async () => {
    // Partner exists but never subscribed: skip silently (documented contract).
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow({ webhookUrl: null })];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload());
    expect(r).toEqual({ ok: false, reason: "no_webhook_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no_secret when credentials carry no webhookSecret", async () => {
    // Security: never send an UNSIGNED event (no shared secret → no send).
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow({ credentials: { appKey: "AK" } })];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload());
    expect(r).toEqual({ ok: false, reason: "no_secret" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no_secret when credentials are null entirely", async () => {
    // decryptIfNeeded(null) → null → `?? {}` fallback → empty secret.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow({ credentials: null })];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload());
    expect(r).toEqual({ ok: false, reason: "no_secret" });
  });
});

describe("sendOutboundEvent — signature & envelope integrity", () => {
  it("signs the data field with HMAC-SHA512 under the partner secret (recomputed in-test)", async () => {
    // Core integrity: recompute the HMAC from scratch and require exact match
    // (wrong algorithm, key, or signed bytes all fail).
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow()];
    const payload = basePayload({ newEta: "2026-06-10T12:30:00Z" });

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", payload, "tr_1:transit.rerouted:1");
    expect(r.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    const envelope = JSON.parse(String(init.body));

    // checksum = HMAC-SHA512 over `data` (= JSON.stringify(payload)).
    const expected = createHmac("sha512", SECRET)
      .update(JSON.stringify(payload))
      .digest("hex");
    expect(envelope.checksum).toBe(expected);
    expect(envelope.data).toBe(JSON.stringify(payload));

    // Header signature must match the body checksum exactly.
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Karhoo-Request-Signature"]).toBe(expected);
  });

  it("decrypts AES-256-GCM encrypted credentials before signing", async () => {
    // Secrets are encrypted at rest: prove the HMAC is keyed with the
    // PLAINTEXT secret (signing path runs decryptIfNeeded).
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [
      partnerRow({ credentials: encryptCredentials({ webhookSecret: SECRET }) }),
    ];
    const payload = basePayload();

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", payload, "k1");
    expect(r.ok).toBe(true);
    const envelope = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.checksum).toBe(
      createHmac("sha512", SECRET).update(JSON.stringify(payload)).digest("hex"),
    );
  });

  it("builds the full envelope: id, event_type, sent_at, attempt_number=1, stringified data", async () => {
    // Published contract (mirrors Karhoo/iCabbi format): partners parse these fields.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow()];

    await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "key-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const envelope = JSON.parse(String(init.body));

    expect(envelope).toEqual({
      id: createHash("sha256").update("key-1").digest("hex").slice(0, 32),
      event_type: "transit.rerouted",
      sent_at: NOW.toISOString(), // frozen clock → exact match
      attempt_number: 1,
      checksum: expect.stringMatching(/^[0-9a-f]{128}$/), // SHA-512 hex = 128 chars
      data: JSON.stringify(basePayload()),
    });

    // Event id + type also travel as headers for partner-side routing.
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Exchange-Event-Id"]).toBe(envelope.id);
    expect(headers["X-Exchange-Event-Type"]).toBe("transit.rerouted");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("never leaks the webhook secret into the request, the delivery record, or the result", async () => {
    // Secret hygiene: the only trace may be the derived HMAC — assert absence
    // everywhere observable.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(dbController.insertCalls)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("sendOutboundEvent — deterministic event ids (dedupe contract)", () => {
  it("derives the event id as sha256(eventKey) truncated to 32 hex chars", async () => {
    // Partners dedupe on event_id; this derivation must stay exact.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "tr_1:transit.rerouted:2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eventId).toBe(
      createHash("sha256").update("tr_1:transit.rerouted:2").digest("hex").slice(0, 32),
    );
    expect(r.eventId).toHaveLength(32);
  });

  it("returns the same event id when re-sending the same eventKey (retry idempotency)", async () => {
    // Same eventKey → same id, so the partner drops the redelivered duplicate.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow()];

    const a = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload({ n: 1 }), "stable-key");
    const b = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload({ n: 2 }), "stable-key");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.eventId).toBe(b.eventId); // payload changed, key didn't → same id
  });

  it("fallback fingerprint is key-order independent (stableStringify determinism)", async () => {
    // No eventKey → id is a fingerprint of (partner, type, payload). Key
    // order is incidental: equivalent payloads must collapse to one id,
    // nested objects included.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow()];

    const a = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", {
      originatorBookingExternalId: "EXT-1",
      transitId: "tr_1",
      detail: { reason: "driver_cancel", fee: 100 },
    });
    const b = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", {
      detail: { fee: 100, reason: "driver_cancel" }, // nested keys reordered
      transitId: "tr_1",
      originatorBookingExternalId: "EXT-1", // top-level keys reordered
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.eventId).toBe(b.eventId);
  });

  it("fallback fingerprint distinguishes different payload VALUES, arrays, and nulls", async () => {
    // Determinism must not collapse different events: array ORDER is
    // semantic, and null/primitives must not throw.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow()];

    const base = { originatorBookingExternalId: "EXT-1", transitId: "tr_1" };
    const a = await sendOutboundEvent(PARTNER_ID, "t", { ...base, stops: ["A", "B"], note: null });
    const b = await sendOutboundEvent(PARTNER_ID, "t", { ...base, stops: ["B", "A"], note: null });
    const c = await sendOutboundEvent(PARTNER_ID, "t", { ...base, stops: ["A", "B"], note: null });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.eventId).not.toBe(b.eventId); // reordered array = different event
    expect(a.eventId).toBe(c.eventId); // identical payload = same event
  });

  it("fallback fingerprint differs across event types and partners", async () => {
    // Different event type (or originator) = different event → ids differ.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow()];

    const a = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload());
    const b = await sendOutboundEvent(PARTNER_ID, "transit.cancelled", basePayload());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("sendOutboundEvent — delivery recording", () => {
  it("records a 'delivered' row with attempts=1 and NO nextAttemptAt on success", async () => {
    // Success queues no retry; row keyed by 'outbound:{partnerId}' + sourceEventId.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(dbController.insertCalls).toHaveLength(1);
    const rec = dbController.insertCalls[0];
    expect(rec.source).toBe(`outbound:${PARTNER_ID}`);
    expect(rec.sourceEventId).toBe(r.eventId);
    expect(rec.outcome).toBe("delivered");
    expect(rec.attempts).toBe(1);
    expect(rec.nextAttemptAt).toBeUndefined(); // no retry scheduled
    // Stored payload keeps envelope + target for the retry loop.
    expect((rec.payload as { target: string }).target).toBe(URL);
  });

  it("on failure, schedules the first retry exactly RETRY_INTERVALS_MS[0] (30s) out", async () => {
    // BDD 1.3: first retry at exactly +30s (frozen clock).
    vi.stubGlobal("fetch", fetchResponding(503, false, "unavailable"));
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r.ok).toBe(false);

    const rec = dbController.insertCalls[0];
    expect(rec.outcome).toBe("delivery_failed");
    expect((rec.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 30_000);
    expect(RETRY_INTERVALS_MS[0]).toBe(30_000);
  });

  it("a duplicate-key insert failure does not mask a successful delivery", async () => {
    // Stable ids make insert conflicts expected on retries; partner already
    // got it → report ok.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.partnerRows = [partnerRow()];
    dbController.throwOnInsert = true;

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r.ok).toBe(true);
  });
});

describe("sendOutboundEvent — failure modes (never throws)", () => {
  it("non-2xx response returns delivery_failed with status and truncated body excerpt", async () => {
    // Error body capped at 200 chars so a hostile huge body can't bloat logs.
    vi.stubGlobal("fetch", fetchResponding(500, false, "x".repeat(300)));
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r).toMatchObject({ ok: false, reason: "delivery_failed", status: 500 });
    if (r.ok || r.reason !== "delivery_failed") return;
    expect(r.message).toBe(`500 ${"x".repeat(200)}`);
  });

  it("a rejecting response body reader still yields a structured failure", async () => {
    // res.text() rejecting (cut mid-body) stays structured via .catch(() => "").
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => Promise.reject(new Error("cut")) }),
    );
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r).toMatchObject({ ok: false, reason: "delivery_failed", status: 502, message: "502 " });
  });

  it("a network-level fetch rejection returns delivery_failed with status 0", async () => {
    // Network failure never reaches HTTP → status 0, message surfaced.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r).toMatchObject({ ok: false, reason: "delivery_failed", status: 0, message: "ECONNREFUSED" });
    // Failure is still recorded for the retry loop.
    expect(dbController.insertCalls[0].outcome).toBe("delivery_failed");
  });

  it("a non-Error throw is stringified rather than crashing the String() path", async () => {
    // Defensive: fetch implementations can reject with non-Error values.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("weird string rejection"));
    dbController.partnerRows = [partnerRow()];

    const r = await sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    expect(r).toMatchObject({ ok: false, reason: "delivery_failed", message: "weird string rejection" });
  });

  it("aborts a hung partner endpoint after the 5s timeout and reports failure", async () => {
    // The 5s AbortController timeout stops a dead partner pinning the
    // function. Hang fetch until abort fires, then advance past 5s.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    dbController.partnerRows = [partnerRow()];

    const pending = sendOutboundEvent(PARTNER_ID, "transit.rerouted", basePayload(), "k");
    await vi.advanceTimersByTimeAsync(5_001); // cross the OUTBOUND_TIMEOUT_MS line
    const r = await pending;
    expect(r).toMatchObject({ ok: false, reason: "delivery_failed", status: 0 });
    if (r.ok || r.reason !== "delivery_failed") return;
    expect(r.message).toContain("aborted");
  });
});

describe("retry policy constants", () => {
  it("locks the BDD Story 1.3 schedule: 30s, 2min, 10min, then flag at 4 attempts", async () => {
    // Shared with webhook-retry.ts; these values are a partner-facing SLA.
    expect(RETRY_INTERVALS_MS).toEqual([30_000, 120_000, 600_000]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(4); // 1 initial + one retry per interval
    expect(MAX_DELIVERY_ATTEMPTS).toBe(RETRY_INTERVALS_MS.length + 1);
  });
});
