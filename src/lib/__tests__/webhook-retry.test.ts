import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outbound webhook retry loop (retryDueDeliveries) — BDD 1.3. Re-POSTs
 * stored envelopes through each row's state machine:
 *   failed + retry ok          → delivered, no further attempts
 *   failed + retry fails       → next retry queued at 2min / 10min
 *   failed + 4th attempt fails → flaggedAt set, retries stop
 *   malformed row              → 'error', flagged immediately (no retry)
 * Key integrity property: the checksum is NEVER recomputed on retry — it
 * signs the stable inner `data`; only attempt_number changes.
 * db / logger / observability mocked; fetch stubbed; clock frozen so
 * backoff timestamps assert exactly.
 */

// Mocked db. dueRows feeds the select; each update's `set` is captured to
// assert the exact transition.
const dbController: {
  dueRows: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  throwOnUpdate: boolean;
} = { dueRows: [], updates: [], throwOnUpdate: false };

vi.mock("@/db/client", () => ({
  db: {
    // Mirrors: db.select().from(webhookDeliveries).where(...).limit(n)
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => dbController.dueRows,
      };
      return chain;
    },
    // Mirrors: db.update(webhookDeliveries).set({...}).where(...)
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          if (dbController.throwOnUpdate) throw new Error("db update exploded");
          dbController.updates.push(v);
        },
      }),
    }),
  },
}));

// Spy-able logger: assert WHICH level fired without coupling to formatting.
const logController = {
  info: [] as Array<[string, Record<string, unknown>]>,
  warn: [] as Array<[string, Record<string, unknown>]>,
};
vi.mock("@/lib/logger", () => ({
  log: {
    debug: () => {},
    info: (msg: string, ctx: Record<string, unknown>) => logController.info.push([msg, ctx]),
    warn: (msg: string, ctx: Record<string, unknown>) => logController.warn.push([msg, ctx]),
    error: () => {},
  },
}));

// captureError sink — rows that crash mid-retry must be reported, not lost.
const capturedErrors: Array<{ err: unknown; ctx: Record<string, unknown> }> = [];
vi.mock("@/lib/observability", () => ({
  captureError: (err: unknown, ctx: Record<string, unknown>) => capturedErrors.push({ err, ctx }),
}));

import { retryDueDeliveries } from "@/lib/webhook-retry";
import { RETRY_INTERVALS_MS, MAX_DELIVERY_ATTEMPTS } from "@/lib/outbound-webhooks";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const TARGET = "https://partner.example.com/webhooks/exchange";
const CHECKSUM = "ab".repeat(64); // stored HMAC-SHA512 hex from the original send

/** A webhook_deliveries row as written by sendOutboundEvent + n failures. */
function deliveryRow(attempts: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `del_${attempts}`,
    source: "outbound:ptr_1",
    sourceEventId: "evt123",
    outcome: "delivery_failed",
    attempts,
    nextAttemptAt: new Date(NOW.getTime() - 1000),
    payload: {
      envelope: {
        id: "evt123",
        event_type: "transit.rerouted",
        sent_at: "2026-06-10T11:55:00.000Z",
        attempt_number: 1,
        checksum: CHECKSUM,
        data: '{"transitId":"tr_1"}',
      },
      target: TARGET,
      eventType: "transit.rerouted",
    },
    ...overrides,
  };
}

function fetchResponding(status: number, ok: boolean, body = "") {
  return vi.fn().mockResolvedValue({ ok, status, text: async () => body });
}

beforeEach(() => {
  dbController.dueRows = [];
  dbController.updates = [];
  dbController.throwOnUpdate = false;
  logController.info = [];
  logController.warn = [];
  capturedErrors.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("retryDueDeliveries — empty tick", () => {
  it("returns all-zero counters and stays silent when nothing is due", async () => {
    // Idle minute-cron must produce zero noise (no log, no fetch).
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await retryDueDeliveries();
    expect(outcome).toEqual({ scanned: 0, delivered: 0, retried_failed: 0, flagged: 0, errored: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logController.info).toHaveLength(0); // scanned>0 guard
  });
});

describe("retryDueDeliveries — successful redelivery", () => {
  it("re-POSTs the stored envelope with bumped attempt_number but UNCHANGED checksum and data", async () => {
    // Signature stability: HMAC covers `data`, unchanged across retries —
    // recomputing it would fail the partner's verification.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.dueRows = [deliveryRow(1)];

    const outcome = await retryDueDeliveries();
    expect(outcome.delivered).toBe(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TARGET);
    const body = JSON.parse(String(init.body));
    expect(body.attempt_number).toBe(2); // attempts(1) + 1
    expect(body.checksum).toBe(CHECKSUM); // NOT recomputed
    expect(body.data).toBe('{"transitId":"tr_1"}'); // bytes-under-signature stable
    expect(body.id).toBe("evt123"); // same event id → partner dedupes

    // Headers mirror the original send, plus the retry-attempt marker.
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Karhoo-Request-Signature"]).toBe(CHECKSUM);
    expect(headers["X-Exchange-Event-Id"]).toBe("evt123");
    expect(headers["X-Exchange-Retry-Attempt"]).toBe("2");
  });

  it("marks the row delivered, clears nextAttemptAt, and records the winning attempt", async () => {
    // Terminal success: nextAttemptAt must go null or the cron re-delivers forever.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.dueRows = [deliveryRow(2)];

    await retryDueDeliveries();
    expect(dbController.updates).toHaveLength(1);
    const set = dbController.updates[0];
    expect(set.outcome).toBe("delivered");
    expect(set.attempts).toBe(3);
    expect(set.nextAttemptAt).toBeNull();
    expect(set.processedAt).toBeInstanceOf(Date);
    // payload is a drizzle sql`jsonb_set(...)` expr — assert presence only.
    expect(set.payload).toBeDefined();
    expect(logController.info.some(([msg]) => msg.includes("retry succeeded"))).toBe(true);
  });
});

describe("retryDueDeliveries — failed redelivery (backoff schedule)", () => {
  it("after the 2nd attempt fails, queues the 3rd at exactly +2min (RETRY_INTERVALS_MS[1])", async () => {
    // attempts=1 → this tick is attempt 2 → next gap = index 1 = 2min.
    // Frozen clock catches off-by-one indexing into the interval table.
    vi.stubGlobal("fetch", fetchResponding(503, false, "down"));
    dbController.dueRows = [deliveryRow(1)];

    const outcome = await retryDueDeliveries();
    expect(outcome.retried_failed).toBe(1);

    const set = dbController.updates[0];
    expect(set.attempts).toBe(2);
    expect((set.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + RETRY_INTERVALS_MS[1]);
    expect((set.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 120_000);
    expect(set.flaggedAt).toBeUndefined(); // not exhausted yet
  });

  it("after the 3rd attempt fails, queues the 4th at exactly +10min (RETRY_INTERVALS_MS[2])", async () => {
    // attempts=2 row → attempt 3 → final gap is index 2 = 10min.
    vi.stubGlobal("fetch", fetchResponding(500, false));
    dbController.dueRows = [deliveryRow(2)];

    const outcome = await retryDueDeliveries();
    expect(outcome.retried_failed).toBe(1);
    expect((dbController.updates[0].nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 600_000);
  });

  it("a network-level rejection counts as a failed attempt and still queues the next retry", async () => {
    // fetch throwing follows the SAME path as a 5xx — not the errored bucket.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    dbController.dueRows = [deliveryRow(1)];

    const outcome = await retryDueDeliveries();
    expect(outcome).toMatchObject({ retried_failed: 1, errored: 0 });
    expect(dbController.updates[0].attempts).toBe(2);
  });

  it("aborts a hung partner after 5s and treats it as a failed attempt", async () => {
    // Same 5s timeout as initial send: an unresponsive partner can't pin the tick.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () =>
              reject(new Error("The operation was aborted")),
            );
          }),
      ),
    );
    dbController.dueRows = [deliveryRow(1)];

    const pending = retryDueDeliveries();
    await vi.advanceTimersByTimeAsync(5_001); // cross RETRY_TIMEOUT_MS
    const outcome = await pending;
    expect(outcome.retried_failed).toBe(1);
  });
});

describe("retryDueDeliveries — terminal states", () => {
  it("flags the row for admin after MAX_DELIVERY_ATTEMPTS and stops retrying", async () => {
    // Exhaustion: attempts=3 → attempt 4 fails → flaggedAt set, nextAttemptAt
    // null. Clearing nextAttemptAt is what stops the loop (select filters on it).
    vi.stubGlobal("fetch", fetchResponding(500, false, "still down"));
    dbController.dueRows = [deliveryRow(MAX_DELIVERY_ATTEMPTS - 1)];

    const outcome = await retryDueDeliveries();
    expect(outcome.flagged).toBe(1);

    const set = dbController.updates[0];
    expect(set.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(set.nextAttemptAt).toBeNull();
    expect(set.flaggedAt).toBeInstanceOf(Date);
    expect(logController.warn.some(([msg]) => msg.includes("exhausted"))).toBe(true);
  });

  it("truncates the partner's error body to 200 chars in the exhaustion log", async () => {
    // Bounded logging: a huge error body must not flood the exhaustion warning.
    vi.stubGlobal("fetch", fetchResponding(500, false, "y".repeat(500)));
    dbController.dueRows = [deliveryRow(3)];

    await retryDueDeliveries();
    const exhausted = logController.warn.find(([msg]) => msg.includes("exhausted"));
    expect(exhausted).toBeDefined();
    expect(exhausted?.[1].last_error).toBe(`500 ${"y".repeat(200)}`);
  });

  it("flags a row whose stored payload is missing the envelope (no retry on garbage)", async () => {
    // Unretryable malformed row: parked as 'error' + flagged immediately.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    dbController.dueRows = [deliveryRow(1, { payload: { target: TARGET } })]; // no envelope

    const outcome = await retryDueDeliveries();
    expect(outcome.flagged).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // never attempted

    const set = dbController.updates[0];
    expect(set.outcome).toBe("error");
    expect(set.nextAttemptAt).toBeNull();
    expect(set.flaggedAt).toBeInstanceOf(Date);
    expect(logController.warn.some(([msg]) => msg.includes("missing envelope/target"))).toBe(true);
  });

  it("flags a row whose stored payload is missing the target URL", async () => {
    // Other half of the guard: an envelope with no target is unretryable.
    const fetchMock = fetchResponding(200, true);
    vi.stubGlobal("fetch", fetchMock);
    const row = deliveryRow(1);
    (row.payload as Record<string, unknown>).target = undefined;
    dbController.dueRows = [row];

    const outcome = await retryDueDeliveries();
    expect(outcome.flagged).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("retryDueDeliveries — crash isolation & batch accounting", () => {
  it("a row whose db update explodes lands in errored and is reported to observability", async () => {
    // One broken row must not abort the tick: counted, captured with its
    // delivery_id, loop continues.
    vi.stubGlobal("fetch", fetchResponding(200, true));
    dbController.dueRows = [deliveryRow(1, { id: "del_boom" })];
    dbController.throwOnUpdate = true;

    const outcome = await retryDueDeliveries();
    expect(outcome).toMatchObject({ scanned: 1, errored: 1, delivered: 0 });
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].ctx).toMatchObject({ area: "webhook-retry", delivery_id: "del_boom" });
  });

  it("aggregates a mixed batch correctly and logs one tick-complete summary", async () => {
    // Mixed tick (delivered + failing + exhausted + malformed) must return
    // exact per-bucket counts.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // Route by target: the "ok" row succeeds, everything else 500s.
      const ok = url.includes("good");
      return Promise.resolve({ ok, status: ok ? 200 : 500, text: async () => "" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const okRow = deliveryRow(1, { id: "ok" });
    ((okRow.payload as Record<string, unknown>).target as unknown) = "https://good.example.com/hook";
    dbController.dueRows = [
      okRow,
      deliveryRow(1, { id: "failing" }), // → retried_failed
      deliveryRow(3, { id: "exhausted" }), // → flagged (attempt 4)
      deliveryRow(1, { id: "garbage", payload: {} }), // → flagged (malformed)
    ];

    const outcome = await retryDueDeliveries();
    expect(outcome).toEqual({ scanned: 4, delivered: 1, retried_failed: 1, flagged: 2, errored: 0 });

    const summary = logController.info.find(([msg]) => msg.includes("tick complete"));
    expect(summary?.[1]).toMatchObject({ scanned: 4, delivered: 1, retried_failed: 1, flagged: 2 });
  });
});
