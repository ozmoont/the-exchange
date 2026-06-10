/**
 * Next.js instrumentation hook — runs once at server boot.
 *
 * Sentry is active when SENTRY_DSN is set. Without it, errors still flow
 * through the structured logger (captureError → log.error with context).
 *
 * Setup:
 *   1. Set SENTRY_DSN in Vercel env vars (Production scope, NOT Sensitive)
 *   2. Optional: NEXT_PUBLIC_SENTRY_DSN for client-side error capture too
 *   3. Optional: tune tracesSampleRate via SENTRY_TRACES_SAMPLE_RATE
 *
 * See docs/OBSERVABILITY.md for the full activation walkthrough.
 */

import { setCaptureFn } from "@/lib/observability";
import { log } from "@/lib/logger";

export async function register() {
  // Server-only init. Next.js sets NEXT_RUNTIME='nodejs' for server functions
  // and 'edge' for middleware. Skip Sentry in edge runtime — the SDK is
  // heavyweight and middleware shouldn't be doing capture anyway.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const sentryDsn = process.env.SENTRY_DSN;
  const env = process.env.NODE_ENV;

  log.info("instrumentation registering", {
    node_env: env,
    sentry_dsn_set: Boolean(sentryDsn),
    disable_auth: process.env.DISABLE_AUTH === "true",
    network_kill_switch: process.env.NETWORK_KILL_SWITCH === "true",
  });

  if (!sentryDsn) {
    log.info("Sentry not activated (SENTRY_DSN not set)");
    return;
  }

  // ------------------------------------------------------------------------
  // Sentry activation
  // ------------------------------------------------------------------------
  // Dynamic import keeps `@sentry/nextjs` out of the edge bundle and means
  // typecheck doesn't require the package to be installed in dev sandboxes
  // (a missing module here logs a warning rather than crashing boot).
  try {
    // Dynamic import keeps @sentry/nextjs out of the edge bundle. The
    // catch keeps boot resilient if a future env loses the package — we'd
    // rather degrade to no-Sentry than crash the server.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sentryModule: any = await import("@sentry/nextjs").catch(() => null);
    if (!sentryModule) {
      log.warn(
        "SENTRY_DSN is set but @sentry/nextjs is not installed. Run `pnpm add @sentry/nextjs` and redeploy.",
      );
      return;
    }
    const Sentry = sentryModule;

    const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1);

    Sentry.init({
      dsn: sentryDsn,
      environment: process.env.VERCEL_ENV ?? env,
      // Adjust sample rate via env var. At pilot scale, 0.1 (10%) keeps
      // the quota comfortable while still surfacing every error path.
      tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
      // Filter noise: don't capture 401s from webhook ingest — those are
      // signature mismatches and are expected during onboarding.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      beforeSend(event: any, hint: any) {
        const err = hint?.originalException;
        if (err instanceof Error && /invalid_signature|stale_event/.test(err.message)) {
          return null;
        }
        return event;
      },
    });

    // Wire captureError → Sentry. Now every captureError call ALSO sends
    // to Sentry with the context fields as Sentry tags.
    setCaptureFn((err, context) => {
      Sentry.captureException(err, { tags: context as Record<string, string> });
    });

    log.info("Sentry initialised", { traces_sample_rate: tracesSampleRate });
  } catch (err) {
    log.warn("Sentry init failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
