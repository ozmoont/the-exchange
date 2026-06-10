import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Structured logger (src/lib/logger.ts). Locks in: dev "[LEVEL] msg {ctx}"
 * text vs prod one-line JSON routed to the level-matching console method;
 * and Error normalisation (JSON.stringify(Error) is {} — fields are
 * non-enumerable — so message/stack/name must be expanded explicitly).
 * isProd is read at module load, so each test re-imports under a stubbed env.
 */

// Fresh logger under a chosen NODE_ENV — module captures isProd at import.
async function loadLogger(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  const mod = await import("@/lib/logger");
  return mod.log;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silence + capture the three console channels the logger writes to.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("dev mode (NODE_ENV != production)", () => {
  it("info pretty-prints with the [INFO] prefix and context JSON via console.log", async () => {
    // Dev format: prefix, message, two spaces, context as JSON.
    const log = await loadLogger("test");
    log.info("routed booking", { transit_id: "tr_1", outcome: "pushed" });
    expect(logSpy).toHaveBeenCalledWith('[INFO] routed booking  {"transit_id":"tr_1","outcome":"pushed"}');
  });

  it("omits the trailing context blob when no context is given", async () => {
    // No context → no dangling '  {}' noise on the line.
    const log = await loadLogger("test");
    log.info("plain message");
    expect(logSpy).toHaveBeenCalledWith("[INFO] plain message");
  });

  it("routes warn to console.warn and error to console.error", async () => {
    // Level → console-method mapping holds in dev too (CI colours stderr).
    const log = await loadLogger("test");
    log.warn("careful", { a: 1 });
    log.error("blew up", { b: 2 });
    expect(warnSpy).toHaveBeenCalledWith('[WARN] careful  {"a":1}');
    expect(errorSpy).toHaveBeenCalledWith('[ERROR] blew up  {"b":2}');
  });

  it("routes debug to console.log with the [DEBUG] prefix", async () => {
    // debug shares console.log with info — only the prefix differs.
    const log = await loadLogger("test");
    log.debug("trace detail");
    expect(logSpy).toHaveBeenCalledWith("[DEBUG] trace detail");
  });

  it("expands Error objects in context into message/stack/name", async () => {
    // Why emit() normalises: raw Error stringifies to {}; the line must
    // carry the message so grep finds it.
    const log = await loadLogger("test");
    log.warn("adapter failed", { err: new Error("boom") });
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain('"message":"boom"');
    expect(line).toContain('"name":"Error"');
    expect(line).toContain('"stack"');
  });
});

describe("prod mode (NODE_ENV=production)", () => {
  it("emits single-line JSON with ts/level/msg plus context fields", async () => {
    // Prod logs: one JSON object per line with a deterministic ts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    const log = await loadLogger("production");
    log.info("routed booking", { transit_id: "tr_9" });
    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      ts: "2026-06-10T12:00:00.000Z",
      level: "info",
      msg: "routed booking",
      transit_id: "tr_9",
    });
  });

  it("routes prod error to console.error and warn to console.warn", async () => {
    // Vercel categorises severity by console method — errors via console.log
    // would hide from error filters.
    const log = await loadLogger("production");
    log.error("bad", { transit_id: "t" });
    log.warn("meh");
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe("error");
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string).level).toBe("warn");
  });

  it("routes prod debug through console.log with level=debug", async () => {
    // debug rides console.log but keeps level=debug for aggregator filtering.
    const log = await loadLogger("production");
    log.debug("verbose");
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).level).toBe("debug");
  });

  it("expands Error context values so prod JSON keeps the message and stack", async () => {
    // Without normalisation err serialises to {} and the incident log is useless.
    const log = await loadLogger("production");
    log.error("adapter blew up", { err: new TypeError("nope") });
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.err.message).toBe("nope");
    expect(parsed.err.name).toBe("TypeError");
    expect(typeof parsed.err.stack).toBe("string");
  });

  it("passes non-Error context values through untouched", async () => {
    // Only Error instances get rewritten; numbers/objects/nulls survive as-is.
    const log = await loadLogger("production");
    log.info("ctx passthrough", { n: 42, nested: { a: [1, 2] }, nil: null });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.n).toBe(42);
    expect(parsed.nested).toEqual({ a: [1, 2] });
    expect(parsed.nil).toBeNull();
  });
});
