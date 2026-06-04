/**
 * Next.js instrumentation hook — runs once at server boot.
 *
 * Right now this does observability setup: logs the boot config and (when
 * activated) initialises Sentry.
 *
 * To activate Sentry:
 *   1. pnpm add @sentry/nextjs
 *   2. Set SENTRY_DSN in Vercel env vars (Production scope, NOT Sensitive)
 *   3. Uncomment the Sentry block below
 *   4. Optional: set NEXT_PUBLIC_SENTRY_DSN if you want client-side error capture too
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
  // Sentry activation block — uncomment after `pnpm add @sentry/nextjs`.
  // ------------------------------------------------------------------------
  //
  // try {
  //   const Sentry = await import("@sentry/nextjs");
  //   Sentry.init({
  //     dsn: sentryDsn,
  //     environment: process.env.VERCEL_ENV ?? env,
  //     // Adjust sample rates as traffic grows. At pilot scale, 1.0 is fine
  //     // since volume is small and we want every error.
  //     tracesSampleRate: 0.1,
  //     // Filter noise:
  //     beforeSend(event, hint) {
  //       // Don't capture 401s from webhook ingest — those are signature
  //       // mismatches and are expected during onboarding.
  //       const err = hint.originalException;
  //       if (err instanceof Error && /invalid_signature|stale_event/.test(err.message)) {
  //         return null;
  //       }
  //       return event;
  //     },
  //   });
  //
  //   // Wire captureError → Sentry. Now every captureError call ALSO sends
  //   // to Sentry with the context fields as Sentry tags.
  //   setCaptureFn((err, context) => {
  //     Sentry.captureException(err, { tags: context as Record<string, string> });
  //   });
  //
  //   log.info("Sentry initialised");
  // } catch (err) {
  //   log.warn("Sentry init failed", { err });
  // }

  // Until the block above is uncommented, observability stays at structured-
  // log level. captureError() in observability.ts logs the error with context.
  log.warn(
    "SENTRY_DSN is set but @sentry/nextjs is not installed. Run `pnpm add @sentry/nextjs` and uncomment the init block in src/instrumentation.ts.",
  );

  void setCaptureFn;
}
