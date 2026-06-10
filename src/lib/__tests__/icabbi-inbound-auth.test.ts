import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inbound Bearer-token auth for iCabbi-tenant callers (H1.5).
 *
 * Two layers are tested here:
 *
 *   A. Header parsing — every malformed Authorization header must be
 *      rejected with a 401 BEFORE any DB work. We prove "no DB call" by
 *      making the mocked db.select throw, so reaching it fails the test.
 *
 *   B. Token matching — once the header shape is valid we scan partner
 *      rows, decrypt each one's stored token, and constant-time compare.
 *      These tests drive that path by configuring the db mock to return
 *      partner rows.
 *
 * The db and crypto modules are mocked through small controllers so a
 * single file can exercise both "DB must not be reached" and "DB returns
 * rows" without conflicting hoisted mocks.
 */

// Controls what the mocked db.select() does. Default: throw, so the
// header-parsing tests prove they never reach the DB.
const dbController: {
  throwOnSelect: boolean;
  rows: Array<Record<string, unknown>>;
} = { throwOnSelect: true, rows: [] };

vi.mock("@/db/client", () => ({
  db: {
    select: () => {
      if (dbController.throwOnSelect) {
        throw new Error("DB reached — should not happen for the malformed-header tests");
      }
      // Minimal drizzle-style chain: .from(...).where(...) resolves to rows.
      const chain = {
        from: () => chain,
        where: async () => dbController.rows,
      };
      return chain;
    },
  },
}));

// decryptIfNeeded is mocked as a passthrough, except a row whose stored
// credentials carry { __throw: true } simulates a decrypt failure (e.g.
// credentials encrypted under a previous PARTNER_CREDENTIAL_KEY).
vi.mock("@/lib/crypto", () => ({
  decryptIfNeeded: (x: Record<string, unknown> | null) => {
    if (x && (x as { __throw?: boolean }).__throw) {
      throw new Error("Unsupported state (simulated wrong-key decrypt)");
    }
    return x;
  },
}));

import { authenticateInboundCaller } from "@/lib/icabbi-inbound-auth";

// A token whose length sits inside the accepted 32–256 char shape window.
const TOKEN = "t".repeat(64);

beforeEach(() => {
  // Reset to the safe default before each test; matching tests opt in.
  dbController.throwOnSelect = true;
  dbController.rows = [];
});

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
    // A 32-char token passes the shape check, so the function proceeds to
    // the DB scan. With db.select mocked to throw, that throw bubbling out
    // proves the shape check passed (no early 401 short-circuit).
    await expect(authenticateInboundCaller(`Bearer ${"x".repeat(32)}`)).rejects.toThrow(
      "DB reached",
    );
  });
});

describe("authenticateInboundCaller — token matching (DB path)", () => {
  it("authenticates a caller whose token matches a partner's credentials", async () => {
    // Happy path: a valid token resolves to that partner's identity.
    dbController.throwOnSelect = false;
    dbController.rows = [
      {
        id: "ptr_1",
        name: "Fleet A",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { inboundBearerToken: TOKEN },
      },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partner).toEqual({
      id: "ptr_1",
      name: "Fleet A",
      adapterKey: "icabbi",
      kind: "icabbi_fleet",
    });
  });

  it("rejects a well-formed token that matches no partner", async () => {
    // Token shape is valid but no row holds it → 401 unknown_token.
    dbController.throwOnSelect = false;
    dbController.rows = [
      {
        id: "ptr_1",
        name: "Fleet A",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { inboundBearerToken: "z".repeat(64) }, // same length, different value
      },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.error).toBe("unknown_token");
  });

  it("skips a row that fails to decrypt and still matches a later row", async () => {
    // Resilience guard: one partner whose credentials can't be decrypted
    // (e.g. encrypted under an old key) must NOT 500 the whole auth path —
    // it's logged and skipped, and a later valid partner still matches.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbController.throwOnSelect = false;
    dbController.rows = [
      {
        id: "ptr_bad",
        name: "Broken Fleet",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { __throw: true }, // decrypt throws → skipped
      },
      {
        id: "ptr_good",
        name: "Fleet B",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { inboundBearerToken: TOKEN },
      },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partner.id).toBe("ptr_good");
    expect(warnSpy).toHaveBeenCalled(); // the bad row was logged, not thrown
    warnSpy.mockRestore();
  });

  it("does not throw when every row fails to decrypt (returns unknown_token)", async () => {
    // Even if ALL partner credentials are undecryptable, the endpoint must
    // degrade to a clean 401 rather than crashing every inbound call.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbController.throwOnSelect = false;
    dbController.rows = [
      { id: "a", name: "A", adapterKey: "icabbi", kind: "icabbi_fleet", credentials: { __throw: true } },
      { id: "b", name: "B", adapterKey: "icabbi", kind: "icabbi_fleet", credentials: { __throw: true } },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unknown_token");
    warnSpy.mockRestore();
  });

  it("skips rows that have no inbound bearer token configured", async () => {
    // A partner row may exist without a token yet (not fully connected) —
    // it must be skipped, not treated as a match.
    dbController.throwOnSelect = false;
    dbController.rows = [
      { id: "no_tok", name: "Pending", adapterKey: "icabbi", kind: "icabbi_fleet", credentials: {} },
      {
        id: "ptr_good",
        name: "Fleet B",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { inboundBearerToken: TOKEN },
      },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partner.id).toBe("ptr_good");
  });

  it("does not match a stored token of a different length", async () => {
    // A stored token whose length differs from the provided one must not
    // match, falling through to unknown_token. (Internally constantTimeEqual
    // short-circuits to false on length mismatch — token length is not
    // secret — but that helper is private, so we assert the observable
    // outcome rather than the constant-time path itself.)
    dbController.throwOnSelect = false;
    dbController.rows = [
      {
        id: "ptr_1",
        name: "Fleet A",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { inboundBearerToken: "t".repeat(48) }, // valid shape, different length than TOKEN(64)
      },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unknown_token");
  });

  it("never writes the bearer token to any log channel", async () => {
    // Security property (see module header in icabbi-inbound-auth.ts): the
    // token must never appear in logs. We capture every console channel
    // during an auth that BOTH logs (a skipped decrypt-failure row emits a
    // warning) AND succeeds — so the assertion is meaningful, not vacuous —
    // then assert the secret shows up in none of the captured output.
    const captured: string[] = [];
    const channels = ["log", "info", "warn", "error", "debug"] as const;
    const spies = channels.map((c) =>
      vi.spyOn(console, c).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
      }),
    );

    dbController.throwOnSelect = false;
    dbController.rows = [
      { id: "bad", name: "Broken", adapterKey: "icabbi", kind: "icabbi_fleet", credentials: { __throw: true } },
      {
        id: "good",
        name: "Fleet B",
        adapterKey: "icabbi",
        kind: "icabbi_fleet",
        credentials: { inboundBearerToken: TOKEN },
      },
    ];

    const r = await authenticateInboundCaller(`Bearer ${TOKEN}`);
    expect(r.ok).toBe(true);
    // Confirm logging actually happened (the skipped bad row warned), so a
    // clean result below isn't just "nothing was ever logged".
    expect(captured.some((line) => line.length > 0)).toBe(true);
    // The provided token must not appear anywhere in the captured logs.
    expect(captured.join("\n")).not.toContain(TOKEN);

    spies.forEach((s) => s.mockRestore());
  });
});

// Keep an explicit afterEach so a future test that mutates global state has
// a clean slate; cheap insurance for this shared-mock file.
afterEach(() => {
  dbController.throwOnSelect = true;
  dbController.rows = [];
});
