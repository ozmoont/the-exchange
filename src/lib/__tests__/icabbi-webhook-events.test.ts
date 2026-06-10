import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ICABBI_WEBHOOK_EVENTS,
  ICABBI_ALLOWED_INBOUND_EVENTS,
  getListenerNamePrefix,
  buildListenerName,
} from "@/lib/icabbi-webhook-events";

/**
 * iCabbi webhook event constants — single source of truth for the adapter
 * (listener registration), inbound ingest allowlist, and integration UI.
 * The allowlist is a security control (ingest rejects events outside it);
 * listener names must stay strict-ASCII, collision-free, and duplicate-free.
 */

// Save/restore prefix env var so no test prefix leaks into other suites.
const ORIGINAL_PREFIX = process.env.ICABBI_WEBHOOK_NAME_PREFIX;
beforeEach(() => {
  delete process.env.ICABBI_WEBHOOK_NAME_PREFIX;
});
afterEach(() => {
  if (ORIGINAL_PREFIX === undefined) delete process.env.ICABBI_WEBHOOK_NAME_PREFIX;
  else process.env.ICABBI_WEBHOOK_NAME_PREFIX = ORIGINAL_PREFIX;
});

describe("ICABBI_WEBHOOK_EVENTS — registered event catalogue", () => {
  it("contains exactly the 13 documented events with no duplicates", () => {
    // Dupes double-register listeners per reset; a drop silently kills a
    // notification. Pin count and uniqueness.
    expect(ICABBI_WEBHOOK_EVENTS).toHaveLength(13);
    expect(new Set(ICABBI_WEBHOOK_EVENTS).size).toBe(13);
  });

  it("keeps the terminal/cancellation events present", () => {
    // These release a driver / refund a passenger; losing one strands
    // bookings in active states.
    for (const e of [
      "booking:booking_cancelled",
      "booking:drivercancelled",
      "booking:dispatch_cancelled",
      "booking:noshow",
    ]) {
      expect(ICABBI_WEBHOOK_EVENTS).toContain(e);
    }
  });
});

describe("getListenerNamePrefix — env validation", () => {
  it("defaults to 'exchange' when the env var is unset", () => {
    // Single-tenant prod runs with no env var — documented default.
    expect(getListenerNamePrefix()).toBe("exchange");
  });

  it("uses a valid custom prefix (multi-tenant staging/prod coexistence)", () => {
    // Two Exchange instances on one iCabbi tenant must not collide.
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "exchange_staging-2";
    expect(getListenerNamePrefix()).toBe("exchange_staging-2");
  });

  it("rejects a prefix with non-ASCII / special characters and falls back", () => {
    // Strict [a-zA-Z0-9_-]: anything else could break iCabbi's UI or
    // smuggle separators into listener names.
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "exchange!$%";
    expect(getListenerNamePrefix()).toBe("exchange");
  });

  it("rejects a prefix longer than 32 chars and falls back", () => {
    // Length cap keeps composed names sane whatever event is appended.
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "x".repeat(33);
    expect(getListenerNamePrefix()).toBe("exchange");
    // Boundary: exactly 32 chars accepted.
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "x".repeat(32);
    expect(getListenerNamePrefix()).toBe("x".repeat(32));
  });

  it("treats an empty-string prefix as unset", () => {
    // `v &&` guard: empty env var must not yield "_booking_completed".
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "";
    expect(getListenerNamePrefix()).toBe("exchange");
  });
});

describe("buildListenerName — composed listener names", () => {
  it("replaces the colon and prefixes the default tenant name", () => {
    // The exact documented example from the module header.
    expect(buildListenerName("booking:completed")).toBe("exchange_booking_completed");
  });

  it("replaces colons globally (regex /:/g, not just the first)", () => {
    // Multi-colon events must be fully underscored; a partial replace
    // would leak ':' into iCabbi's UI.
    expect(buildListenerName("request:save")).toBe("exchange_request_save");
    // Cast exercises the global flag with a hypothetical two-colon event.
    expect(buildListenerName("a:b:c" as (typeof ICABBI_WEBHOOK_EVENTS)[number])).toBe("exchange_a_b_c");
  });

  it("honours a custom prefix for every registered event and stays strict-ASCII", () => {
    // Full-catalogue sweep: every composed name must be ASCII-safe and
    // carry the tenant prefix (the multi-tenant collision guarantee).
    process.env.ICABBI_WEBHOOK_NAME_PREFIX = "staging";
    for (const e of ICABBI_WEBHOOK_EVENTS) {
      const name = buildListenerName(e);
      expect(name).toMatch(/^staging_[a-z_]+$/);
      expect(name.startsWith("staging_")).toBe(true);
    }
  });
});

describe("ICABBI_ALLOWED_INBOUND_EVENTS — ingest-route allowlist", () => {
  it("is exactly the 13 registered events plus the synthesized 'status_update'", () => {
    // SECURITY PIN: ingest rejects events outside this set — a valid-token
    // caller still can't write arbitrary event types. Pin the exact size.
    expect(ICABBI_ALLOWED_INBOUND_EVENTS.size).toBe(14);
    for (const e of ICABBI_WEBHOOK_EVENTS) {
      expect(ICABBI_ALLOWED_INBOUND_EVENTS.has(e)).toBe(true);
    }
    expect(ICABBI_ALLOWED_INBOUND_EVENTS.has("status_update")).toBe(true);
  });

  it("rejects event types outside the subscription set", () => {
    // Negative cases: lookalike and arbitrary strings must not pass.
    expect(ICABBI_ALLOWED_INBOUND_EVENTS.has("booking:made_up")).toBe(false);
    expect(ICABBI_ALLOWED_INBOUND_EVENTS.has("BOOKING:COMPLETED")).toBe(false); // case-sensitive
    expect(ICABBI_ALLOWED_INBOUND_EVENTS.has("")).toBe(false);
  });
});
