/**
 * Observability hook — wraps Sentry capture but doesn't hard-depend on the
 * package being installed. Lets us replace `console.error` everywhere right
 * now and activate Sentry later by:
 *
 *   1. pnpm add @sentry/nextjs
 *   2. Set SENTRY_DSN in Vercel env vars
 *   3. Uncomment the Sentry.init() block in instrumentation.ts
 *   4. Set the captureFn below to call Sentry.captureException
 *
 * Until activated, captureError just structured-logs. After activation, it
 * does both — logs stay useful for grep-able context, Sentry stores the
 * full event with stack + breadcrumbs.
 *
 * The captureFn is intentionally a mutable reference (not a const import)
 * so the instrumentation hook can wire Sentry in at boot time without
 * every call site changing.
 */

import { log } from "@/lib/logger";

export type CaptureContext = {
  /** Booking / transit id, when relevant. */
  transit_id?: string;
  /** Partner id, when relevant. */
  partner_id?: string;
  /** Request id from the request lifecycle, when available. */
  request_id?: string;
  /** Free-form tags. */
  [key: string]: unknown;
};

type CaptureFn = (err: unknown, context: CaptureContext) => void;

/**
 * The capture sink. Default implementation just logs. The instrumentation
 * hook (src/instrumentation.ts) overrides this when Sentry is initialized.
 */
let captureFn: CaptureFn = defaultCapture;

function defaultCapture(err: unknown, context: CaptureContext): void {
  const e = err instanceof Error ? err : new Error(String(err));
  log.error(e.message, { ...context, err: e });
}

/**
 * Capture an error. Always logs. Also sends to Sentry once activated.
 * Safe to call from any async / cron / webhook path. Never throws.
 */
export function captureError(err: unknown, context: CaptureContext = {}): void {
  try {
    captureFn(err, context);
  } catch {
    // Capture sinks should never crash the caller. Fall back to console.
    console.error("[observability] captureFn itself threw", err);
  }
}

/**
 * Override the capture sink. Called from instrumentation.ts after Sentry
 * is initialized. Subsequent captureError calls dispatch to Sentry.
 */
export function setCaptureFn(fn: CaptureFn): void {
  captureFn = fn;
}

/**
 * Convenience for "I caught this, but I want it tracked AND I want to
 * rethrow". Most async paths use captureError + return early instead.
 */
export function captureAndRethrow(err: unknown, context: CaptureContext = {}): never {
  captureError(err, context);
  throw err;
}
