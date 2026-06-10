import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitBuckets } from "@/db/schema";

/**
 * Postgres fixed-window rate limiter (src/lib/rate-limit.ts) — abuse guard
 * for webhook ingest, magic-link requests and login attempts. Tests set the
 * upsert RETURNING count, then assert allow/deny, remaining budget, and
 * retry-after math (fake timers keep window arithmetic exact).
 */

// Mocked db. `executeResult` is the upsert return; both shapes the source
// handles (bare array and { rows }) are exercised via different values.
const dbController = {
  executeResult: [] as unknown,
  executeCalls: 0,
  deleteCalls: [] as { table: unknown }[],
};

vi.mock("@/db/client", () => ({
  db: {
    execute: async (_q: unknown) => {
      dbController.executeCalls += 1;
      return dbController.executeResult;
    },
    delete: (table: unknown) => ({
      where: (_cond: unknown) => {
        dbController.deleteCalls.push({ table });
        return Promise.resolve([]);
      },
    }),
  },
}));

import {
  checkRateLimit,
  cleanupOldRateLimitRows,
  LIMIT_INGEST_PER_PARTNER,
  WINDOW_INGEST_SECONDS,
  LIMIT_MAGIC_LINK_PER_EMAIL,
  WINDOW_MAGIC_LINK_SECONDS,
  LIMIT_LOGIN_PER_IP,
  WINDOW_LOGIN_SECONDS,
} from "@/lib/rate-limit";

// Fixed instant on a minute boundary so window arithmetic is predictable.
const WINDOW_START = Date.UTC(2026, 5, 10, 12, 0, 0);

beforeEach(() => {
  dbController.executeResult = [];
  dbController.executeCalls = 0;
  dbController.deleteCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit — allow/deny decisions", () => {
  it("allows a request under the limit and reports the remaining budget", async () => {
    // Under-limit request passes; remaining = limit - count.
    dbController.executeResult = [{ count: 1 }];
    const r = await checkRateLimit("partner:p1", 5, 60);
    expect(r).toEqual({ ok: true, remaining: 4 });
  });

  it("allows the request that exactly reaches the limit (remaining 0)", async () => {
    // Boundary off-by-one: count === limit is allowed; only exceeding denies.
    dbController.executeResult = [{ count: 5 }];
    const r = await checkRateLimit("partner:p1", 5, 60);
    expect(r).toEqual({ ok: true, remaining: 0 });
  });

  it("denies the request just past the limit with a retry hint", async () => {
    // The guard itself: request #limit+1 is denied, remaining clamped to 0.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START + 10_000)); // 10s into the window
    dbController.executeResult = [{ count: 6 }];
    const r = await checkRateLimit("partner:p1", 5, 60);
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
    // 60s window started at WINDOW_START; 10s in → 50s until it resets.
    expect(r.retryAfterSeconds).toBe(50);
  });

  it("never reports retryAfterSeconds below 1, even at the window's last ms", async () => {
    // Retry-After: 0 would invite an immediate retry storm; floor is 1s.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START + 59_999));
    dbController.executeResult = [{ count: 99 }];
    const r = await checkRateLimit("partner:p1", 5, 60);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBe(1);
  });

  it("computes the window from windowSeconds (hour-long magic-link window)", async () => {
    // 3600s window, 10min in → 50min left: windowSeconds drives bucket size.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START + 10 * 60 * 1000));
    dbController.executeResult = [{ count: 6 }];
    const r = await checkRateLimit("email:a@x.com", 5, 3600);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBe(50 * 60);
  });
});

describe("checkRateLimit — driver result-shape tolerance", () => {
  it("reads the count from a { rows: [...] } shaped result", async () => {
    // drizzle may wrap rows; both shapes must parse identically or a driver
    // upgrade silently breaks the limiter.
    dbController.executeResult = { rows: [{ count: 3 }] };
    const r = await checkRateLimit("k", 5, 60);
    expect(r).toEqual({ ok: true, remaining: 2 });
  });

  it("defaults the count to 1 when the result has no rows", async () => {
    // Fail OPEN on a missing RETURNING row: count as first request, not block all.
    dbController.executeResult = [];
    const r = await checkRateLimit("k", 5, 60);
    expect(r).toEqual({ ok: true, remaining: 4 });
  });

  it("defaults the count to 1 when the result is an object without rows", async () => {
    // `.rows ?? []` guard for an unexpected return: no crash, fails open as 1.
    dbController.executeResult = {};
    const r = await checkRateLimit("k", 5, 60);
    expect(r).toEqual({ ok: true, remaining: 4 });
  });
});

describe("cleanupOldRateLimitRows", () => {
  it("issues a delete against rate_limit_buckets and returns 0", async () => {
    // Best-effort GC: must hit the right table; pinned return is 0 (not a
    // real count) so callers don't read it as "nothing deleted".
    const n = await cleanupOldRateLimitRows();
    expect(n).toBe(0);
    expect(dbController.deleteCalls).toHaveLength(1);
    expect(dbController.deleteCalls[0].table).toBe(rateLimitBuckets);
  });
});

describe("exported limit constants", () => {
  it("pins the abuse thresholds so loosening them is a visible diff", () => {
    // These numbers ARE the security policy; any change must surface in review.
    expect(LIMIT_INGEST_PER_PARTNER).toBe(60);
    expect(WINDOW_INGEST_SECONDS).toBe(60);
    expect(LIMIT_MAGIC_LINK_PER_EMAIL).toBe(5);
    expect(WINDOW_MAGIC_LINK_SECONDS).toBe(60 * 60);
    expect(LIMIT_LOGIN_PER_IP).toBe(20);
    expect(WINDOW_LOGIN_SECONDS).toBe(5 * 60);
  });
});
