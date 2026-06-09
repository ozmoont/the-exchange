import { describe, expect, it, vi } from "vitest";

/**
 * H1.5 — Bearer token auth header parsing. The fully-resolved auth flow
 * touches the DB (it scans partners), but the header-parsing edge cases
 * fail before any DB call so we can test them in isolation by mocking
 * the db module to throw if reached (proving we never get there).
 *
 * Behaviour we lock in:
 *   1. Missing Authorization header → 401 missing_authorization
 *   2. Non-Bearer scheme → 401 invalid_authorization_scheme
 *   3. "Bearer " with no token → 401 missing_token
 *   4. Token outside the 32-256 char shape range → 401 invalid_token_format
 *      WITHOUT touching the DB
 */

vi.mock("@/db/client", () => ({
  db: {
    select: () => {
      throw new Error("DB reached — should not happen for the malformed-header tests");
    },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decryptIfNeeded: (x: unknown) => x,
}));

import { authenticateInboundCaller } from "@/lib/icabbi-inbound-auth";

describe("authenticateInboundCaller — header parsing", () => {
  it("rejects null Authorization header", async () => {
    const r = await authenticateInboundCaller(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.error).toBe("missing_authorization");
  });

  it("rejects empty string Authorization header", async () => {
    const r = await authenticateInboundCaller("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_authorization");
  });

  it("rejects non-Bearer scheme", async () => {
    const r = await authenticateInboundCaller("Basic dXNlcjpwYXNz");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_authorization_scheme");
  });

  it("rejects Bearer with empty token", async () => {
    const r = await authenticateInboundCaller("Bearer ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_token");
  });

  it("rejects Bearer with token shorter than 32 chars before any DB call", async () => {
    const r = await authenticateInboundCaller("Bearer short");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_token_format");
  });

  it("rejects Bearer with token longer than 256 chars before any DB call", async () => {
    const r = await authenticateInboundCaller(`Bearer ${"x".repeat(300)}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_token_format");
  });

  it("accepts token at exact MIN length and proceeds to DB lookup", async () => {
    // A 32-char token should pass shape check. Without a matching partner
    // row (mocked db throws), we'd see the throw bubble. So we mock db
    // differently for this case — but the assertion we care about is that
    // the shape check passes. The mock throws and the catch in
    // authenticateInboundCaller catches Postgres errors at the bottom of
    // the for-loop — it doesn't catch this one, so the function throws.
    // We assert that behaviour: the SHAPE check passed (no early 401),
    // even though the actual lookup is unmocked here.
    await expect(authenticateInboundCaller(`Bearer ${"x".repeat(32)}`)).rejects.toThrow(
      "DB reached",
    );
  });
});
