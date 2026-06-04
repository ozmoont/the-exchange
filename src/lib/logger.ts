/**
 * Tiny structured logger.
 *
 * In production: JSON one-line-per-event so Vercel log search and downstream
 * aggregators (Logflare, Datadog, etc.) can index fields. In dev:
 * pretty-printed text so terminals stay readable.
 *
 * The whole point is that every log line carries useful context fields —
 * `transit_id`, `partner_id`, `request_id` — so when something goes wrong
 * you can grep the logs and see the whole story without correlating across
 * 6 lines of unstructured output.
 *
 * Usage:
 *
 *   import { log } from "@/lib/logger";
 *
 *   log.info("routed booking", { transit_id, partner_id, outcome });
 *   log.warn("retry exhausted", { transit_id, attempts });
 *   log.error("adapter blew up", { transit_id, err });
 *
 * For Error capture that should ALSO go to Sentry, use captureError() from
 * @/lib/observability instead. log.error is fine for non-actionable warnings.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const isProd = process.env.NODE_ENV === "production";

type LogContext = Record<string, unknown>;

function emit(level: LogLevel, msg: string, ctx: LogContext = {}): void {
  // Normalise Error objects in context — JSON.stringify of an Error returns
  // {} because the fields are non-enumerable. Capture .message and .stack
  // explicitly.
  const normalised: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v instanceof Error) {
      normalised[k] = { message: v.message, stack: v.stack, name: v.name };
    } else {
      normalised[k] = v;
    }
  }

  if (isProd) {
    // Single-line JSON. Vercel function logs index this; downstream
    // aggregators can ingest it without parsing.
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...normalised,
    };
    // Pick the right console method so Vercel categorises levels correctly
    if (level === "error") console.error(JSON.stringify(entry));
    else if (level === "warn") console.warn(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
    return;
  }

  // Dev pretty-print
  const contextStr = Object.keys(normalised).length
    ? "  " + JSON.stringify(normalised)
    : "";
  const prefix = `[${level.toUpperCase()}] `;
  if (level === "error") console.error(prefix + msg + contextStr);
  else if (level === "warn") console.warn(prefix + msg + contextStr);
  else console.log(prefix + msg + contextStr);
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit("error", msg, ctx),
};
