import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Observability hook (src/lib/observability.ts). It's a mutable capture sink
 * (`captureFn`) instrumentation.ts later points at Sentry — so we test the
 * sink mechanism with a Sentry-shaped fake, not the Sentry package: default
 * sink logs via @/lib/logger, setCaptureFn swaps it, captureError never
 * throws, captureAndRethrow rethrows the same instance. captureFn is
 * module-level state → each test loads a fresh module copy.
 */

// Logger mock pushes here; the array survives resetModules (factory closes
// over the same outer reference).
const logCalls: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
vi.mock("@/lib/logger", () => ({
  log: {
    error: (msg: string, ctx?: Record<string, unknown>) => {
      logCalls.push({ msg, ctx: ctx ?? {} });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

// Fresh module per test so setCaptureFn mutations can't leak.
async function loadObservability() {
  vi.resetModules();
  return await import("@/lib/observability");
}

beforeEach(() => {
  logCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureError — default sink", () => {
  it("logs the error message with the context and the Error itself", async () => {
    // Pre-Sentry: captureError still leaves a grep-able log line with the
    // call-site context fields.
    const { captureError } = await loadObservability();
    const err = new Error("adapter timeout");
    captureError(err, { transit_id: "tr_1", partner_id: "p_9" });

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].msg).toBe("adapter timeout");
    expect(logCalls[0].ctx.transit_id).toBe("tr_1");
    expect(logCalls[0].ctx.partner_id).toBe("p_9");
    // Error rides under `err` so the logger can expand its stack.
    expect(logCalls[0].ctx.err).toBe(err);
  });

  it("wraps non-Error throwables in an Error", async () => {
    // Code can `throw "string"` — wrap it in an Error, don't crash on .message.
    const { captureError } = await loadObservability();
    captureError("plain string failure", { area: "test" });

    expect(logCalls[0].msg).toBe("plain string failure");
    expect(logCalls[0].ctx.err).toBeInstanceOf(Error);
    expect((logCalls[0].ctx.err as Error).message).toBe("plain string failure");
  });

  it("defaults the context to an empty object when omitted", async () => {
    // captureError(err) with no context is the common shape — must not throw.
    const { captureError } = await loadObservability();
    captureError(new Error("no ctx"));
    expect(logCalls[0].msg).toBe("no ctx");
  });
});

describe("setCaptureFn — sink replacement (the Sentry activation path)", () => {
  it("routes subsequent captureError calls to the new sink instead of the logger", async () => {
    // What instrumentation.ts does at boot: point the sink at Sentry. After
    // the swap the default logger sink must no longer fire.
    const { captureError, setCaptureFn } = await loadObservability();
    const sentryLike = vi.fn(); // stands in for Sentry.captureException wiring
    setCaptureFn(sentryLike);

    const err = new Error("goes to sentry");
    captureError(err, { transit_id: "tr_2" });

    expect(sentryLike).toHaveBeenCalledWith(err, { transit_id: "tr_2" });
    expect(logCalls).toHaveLength(0); // default sink fully replaced
  });

  it("captureError never throws even when the sink itself throws", async () => {
    // Contract: a sink must never crash the caller (webhooks, crons) — a
    // broken sink falls back to console.error.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureError, setCaptureFn } = await loadObservability();
    setCaptureFn(() => {
      throw new Error("sink exploded");
    });

    expect(() => captureError(new Error("original"))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[observability] captureFn itself threw",
      expect.any(Error),
    );
  });
});

describe("captureAndRethrow", () => {
  it("captures through the active sink and rethrows the same instance", async () => {
    // Track-and-propagate: rethrown value must be the identical instance so
    // upstream catch / instanceof checks keep working.
    const { captureAndRethrow, setCaptureFn } = await loadObservability();
    const sink = vi.fn();
    setCaptureFn(sink);

    const err = new Error("fatal");
    let caught: unknown;
    try {
      captureAndRethrow(err, { request_id: "req_1" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(sink).toHaveBeenCalledWith(err, { request_id: "req_1" });
  });

  it("rethrows non-Error values as-is after capturing via the default sink", async () => {
    // Default-context + default-sink: still logs, rethrows the unwrapped value.
    const { captureAndRethrow } = await loadObservability();
    let caught: unknown;
    try {
      captureAndRethrow("string failure");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe("string failure");
    expect(logCalls[0].msg).toBe("string failure");
  });
});
