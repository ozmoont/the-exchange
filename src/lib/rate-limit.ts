/**
 * Postgres-backed rate limiter.
 *
 * Per-key fixed-window counter, suitable for pilot-scale traffic (low
 * hundreds of req/min). Upgrade path to Upstash Redis when partners scale
 * beyond ~1000 req/min — the `checkRateLimit` signature stays the same so
 * callers don't change.
 *
 * Trade-offs of fixed-window vs sliding-window:
 *   - Simpler — one row per (key, windowStart)
 *   - Boundary effects (burst at window edges could double the limit)
 *   - Fine for "stop a misbehaving partner from DOSing us", less fine for
 *     fair-share quotas. The latter isn't a pilot concern.
 *
 * Cleanup: rows older than 24h are GC'd by a periodic sweep — see
 * `cleanupOldRateLimitRows` in lib/demo.ts's tick (re-uses the existing
 * cooldown infrastructure).
 */

import { db } from "@/db/client";
import { rateLimitBuckets } from "@/db/schema";
import { and, eq, lt, sql } from "drizzle-orm";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Seconds until the next window if rejected, undefined when ok. */
  retryAfterSeconds?: number;
};

/**
 * Increment the counter for `key` in the current window. Returns ok=false
 * when the count exceeds `limit`. The window is defined by `windowSeconds`
 * — e.g. 60 for "60 requests per minute".
 *
 * Atomic via INSERT ... ON CONFLICT DO UPDATE so concurrent requests don't
 * race.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStartMs = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const windowStart = new Date(windowStartMs);

  // Atomic upsert + return the new count
  const result = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart.toISOString()}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = rate_limit_buckets.count + 1
    RETURNING count
  `);

  // postgres.js + drizzle returns rows directly OR { rows: [...] }
  const rows = Array.isArray(result)
    ? (result as unknown as { count: number }[])
    : (result as unknown as { rows: { count: number }[] }).rows ?? [];
  const count = rows[0]?.count ?? 1;

  if (count > limit) {
    const retryAfterSeconds = Math.ceil((windowStartMs + windowSeconds * 1000 - now) / 1000);
    return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }
  return { ok: true, remaining: Math.max(0, limit - count) };
}

/**
 * Garbage-collect rate-limit rows older than 24h. Safe to call repeatedly;
 * idempotent.
 */
export async function cleanupOldRateLimitRows(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.windowStart, cutoff));
  // drizzle returns metadata rather than count consistently; estimate by
  // counting deleted via a sibling query if needed. For now return 0 — the
  // delete is best-effort.
  void result;
  void and;
  void eq;
  return 0;
}

// ---------------------------------------------------------------------------
// Suggested limits for the calling sites. Tune per partner-tier if needed.
// ---------------------------------------------------------------------------

/** Inbound webhook ingest — per partner per minute. */
export const LIMIT_INGEST_PER_PARTNER = 60;
export const WINDOW_INGEST_SECONDS = 60;

/** Magic-link request — per email per hour. Stops password-reset spam. */
export const LIMIT_MAGIC_LINK_PER_EMAIL = 5;
export const WINDOW_MAGIC_LINK_SECONDS = 60 * 60;

/** Login attempts — per IP per 5 minutes. */
export const LIMIT_LOGIN_PER_IP = 20;
export const WINDOW_LOGIN_SECONDS = 5 * 60;
