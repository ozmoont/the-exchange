import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { users, magicLinks, authSessions } from "@/db/schema";

/**
 * Security tests for the auth core (src/lib/auth.ts): HMAC-signed cookies,
 * email allowlist, magic-link issue/consume, session lifecycle, RBAC guards.
 * Properties locked in:
 *   - a cookie not signed by OUR secret never yields a session id (forged,
 *     tampered, truncated, garbage all fail closed)
 *   - magic links are single-use and expire after 15 minutes
 *   - sessions are revocable; a deleted user's session dies on next read
 *   - role guards make privilege escalation a redirect, not a data leak
 * DB / next/headers / next/navigation mocked via controllers — no real DB.
 */

type Row = Record<string, unknown>;

// Mocked drizzle chains, routed by real-schema table identity.
const dbController = {
  usersRows: [] as Row[],
  magicLinkRows: [] as Row[],
  sessionRows: [] as Row[],
  /** What `db.select({ n: count() }).from(users)` reports (bootstrap check). */
  userCount: 0,
  /** Rows returned by `.insert().values().returning()` (findOrCreateUser). */
  insertReturningRows: [] as Row[],
  // Write-side recorders so tests can assert what was persisted.
  inserts: [] as { table: unknown; values: Row }[],
  updates: [] as { table: unknown; set: Row }[],
  deletes: [] as { table: unknown }[],
  reset() {
    this.usersRows = [];
    this.magicLinkRows = [];
    this.sessionRows = [];
    this.userCount = 0;
    this.insertReturningRows = [];
    this.inserts = [];
    this.updates = [];
    this.deletes = [];
  },
};

function rowsForTable(table: unknown): Row[] {
  if (table === users) return dbController.usersRows;
  if (table === magicLinks) return dbController.magicLinkRows;
  if (table === authSessions) return dbController.sessionRows;
  return [];
}

vi.mock("@/db/client", () => ({
  db: {
    // Two select shapes: .from(t).where() → rows; .select({n:count()}).from
    // (users) → [{n: userCount}] (awaited directly, no .where).
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        const rows =
          fields !== undefined ? [{ n: dbController.userCount }] : rowsForTable(table);
        return {
          where: (_cond: unknown) => Promise.resolve(rows),
          // thenable so `await db.select({...}).from(users)` works
          then: (onF?: (v: Row[]) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(onF, onR),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Row) => {
        dbController.inserts.push({ table, values: vals });
        return {
          returning: () => Promise.resolve(dbController.insertReturningRows),
          // thenable so `await db.insert(t).values(v)` (no .returning) works
          then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve(undefined).then(onF, onR),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: (_cond: unknown) => {
          dbController.updates.push({ table, set });
          return Promise.resolve();
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (_cond: unknown) => {
        dbController.deletes.push({ table });
        return Promise.resolve();
      },
    }),
  },
}));

// Cookie-store mock for next/headers. jar = browser; setCalls/deleted record
// store calls so tests assert cookie flags (httpOnly, sameSite, secure, expiry).
const cookieController = {
  jar: new Map<string, string>(),
  setCalls: [] as { name: string; value: string; options: Row }[],
  deleted: [] as string[],
  reset() {
    this.jar.clear();
    this.setCalls = [];
    this.deleted = [];
  },
};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieController.jar.has(name)
        ? { name, value: cookieController.jar.get(name) as string }
        : undefined,
    set: (name: string, value: string, options: Row) => {
      cookieController.jar.set(name, value);
      cookieController.setCalls.push({ name, value, options });
    },
    delete: (name: string) => {
      cookieController.jar.delete(name);
      cookieController.deleted.push(name);
    },
  }),
}));

// redirect() throws NEXT_REDIRECT (as in real Next.js) so tests assert the dest.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import {
  AUTH_COOKIE_NAME,
  verifyAndExtractSessionId,
  isEmailAllowed,
  findOrCreateUser,
  createMagicLinkToken,
  consumeMagicLinkToken,
  createSession,
  destroySession,
  getCurrentUser,
  requireUser,
  requireSuperAdmin,
  requirePartnerAccess,
  requirePartnerWrite,
  type SessionUser,
} from "@/lib/auth";

// Known secret (≥16 chars) so tests compute the same HMAC auth.ts does.
const TEST_SECRET = "unit-test-auth-secret-0123456789";

/** Sign a session id exactly the way auth.ts's private signSessionId does. */
function sign(sessionId: string, secret = TEST_SECRET): string {
  const sig = createHmac("sha256", secret).update(sessionId).digest("base64url");
  return `${sessionId}.${sig}`;
}

/** Fully logged-in user: signed cookie + live session row + users row. */
function loginAs(user: SessionUser): void {
  const sessionId = `sess-${user.id}`;
  cookieController.jar.set(AUTH_COOKIE_NAME, sign(sessionId));
  dbController.sessionRows = [
    { id: sessionId, email: user.email, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  ];
  dbController.usersRows = [
    { id: user.id, email: user.email, role: user.role, partnerId: user.partnerId },
  ];
}

// Save/restore touched env vars so nothing leaks into other suites.
const ORIGINAL_ENV = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  DISABLE_AUTH: process.env.DISABLE_AUTH,
};

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
  delete process.env.ALLOWED_EMAILS;
  delete process.env.DISABLE_AUTH;
  dbController.reset();
  cookieController.reset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// verifyAndExtractSessionId — the cookie integrity gate
describe("verifyAndExtractSessionId — HMAC cookie verification", () => {
  it("accepts a correctly signed cookie and returns the session id", () => {
    // Happy path: the round-trip middleware/pages depend on.
    const id = "session-abc-123";
    expect(verifyAndExtractSessionId(sign(id))).toBe(id);
  });

  it("supports session ids that themselves contain dots", () => {
    // Parser splits on the LAST dot, so a dotted id must still verify.
    const id = "a.b.c";
    expect(verifyAndExtractSessionId(sign(id))).toBe("a.b.c");
  });

  it("rejects a cookie with no dot separator (random garbage)", () => {
    // Arbitrary junk must never produce a session id.
    expect(verifyAndExtractSessionId("just-garbage-no-dot")).toBeNull();
  });

  it("rejects a cookie with an empty session id part", () => {
    // ".<sig>" — empty id must fail closed, not look up an empty-string row.
    const sig = createHmac("sha256", TEST_SECRET).update("").digest("base64url");
    expect(verifyAndExtractSessionId(`.${sig}`)).toBeNull();
  });

  it("rejects a cookie with an empty signature part", () => {
    // "id." — stripping the signature off a stolen id must not authenticate.
    expect(verifyAndExtractSessionId("session-abc-123.")).toBeNull();
  });

  it("rejects a signature of the wrong length (truncated cookie)", () => {
    // Length mismatch is rejected before timingSafeEqual (which would throw).
    expect(verifyAndExtractSessionId("session-abc-123.shortsig")).toBeNull();
  });

  it("rejects a forged signature of the correct length", () => {
    // Anti-forgery: same-length wrong-value signature fails the timing-safe compare.
    const valid = sign("session-abc-123");
    const dot = valid.lastIndexOf(".");
    const sig = valid.slice(dot + 1);
    const forged = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyAndExtractSessionId(`session-abc-123.${forged}`)).toBeNull();
  });

  it("rejects a cookie whose id was swapped after signing", () => {
    // Signature is bound to the id: splicing a valid sig onto another id fails.
    const valid = sign("victim-session");
    const sig = valid.slice(valid.lastIndexOf(".") + 1);
    expect(verifyAndExtractSessionId(`attacker-session.${sig}`)).toBeNull();
  });

  it("returns null (not throw) when AUTH_SECRET is missing", () => {
    // Misconfigured deploy fails closed: no secret → no valid sessions, no 500.
    delete process.env.AUTH_SECRET;
    expect(verifyAndExtractSessionId(sign("session-abc-123"))).toBeNull();
  });

  it("returns null when AUTH_SECRET is shorter than 16 chars", () => {
    // A <16-char secret is treated as no secret, so its cookies never verify.
    process.env.AUTH_SECRET = "x".repeat(15);
    expect(verifyAndExtractSessionId(sign("session-abc-123", "x".repeat(15)))).toBeNull();
  });

  it("rejects a cookie signed under a different secret", () => {
    // Secret rotation invalidates outstanding cookies (old-secret cookie fails).
    const oldCookie = sign("session-abc-123", "previous-secret-0123456789abcd");
    expect(verifyAndExtractSessionId(oldCookie)).toBeNull();
  });
});

// isEmailAllowed — login allowlist
describe("isEmailAllowed — users table + ALLOWED_EMAILS bootstrap", () => {
  it("allows an email with an existing users-table row", async () => {
    // Real users get in regardless of the env allowlist.
    dbController.usersRows = [{ id: "u1", email: "user@fleet.com" }];
    await expect(isEmailAllowed("user@fleet.com")).resolves.toBe(true);
  });

  it("denies an unknown email when ALLOWED_EMAILS is unset", async () => {
    // Default-deny: with no allowlist configured, nobody new gets in.
    await expect(isEmailAllowed("stranger@evil.com")).resolves.toBe(false);
  });

  it("allows an env-allowlisted email (bootstrap path)", async () => {
    // Founder bootstrap: env-listed emails may log in before any user rows.
    process.env.ALLOWED_EMAILS = "founder@x.com,ops@x.com";
    await expect(isEmailAllowed("ops@x.com")).resolves.toBe(true);
  });

  it("matches the allowlist case-insensitively and trims whitespace", async () => {
    // Casing and stray whitespace in the env must not break the allowlist.
    process.env.ALLOWED_EMAILS = "  Founder@X.com , ops@x.com ";
    await expect(isEmailAllowed("FOUNDER@x.COM")).resolves.toBe(true);
  });

  it("denies an email not on the allowlist even when others are", async () => {
    // The allowlist is exact-match, not substring/domain match.
    process.env.ALLOWED_EMAILS = "founder@x.com";
    await expect(isEmailAllowed("notfounder@x.com")).resolves.toBe(false);
  });

  it("never allows the empty string, even with messy env entries", async () => {
    // Empty entries from " , ," must be filtered; empty-email login denied.
    process.env.ALLOWED_EMAILS = " , ,";
    await expect(isEmailAllowed("")).resolves.toBe(false);
  });
});

// findOrCreateUser — post-verification user resolution
describe("findOrCreateUser", () => {
  it("returns the existing user and stamps lastLoginAt", async () => {
    // Login must not mutate role/partner, only stamp lastLoginAt.
    dbController.usersRows = [
      { id: "u1", email: "user@fleet.com", role: "fleet_admin", partnerId: "p1" },
    ];
    const u = await findOrCreateUser("USER@fleet.com");
    expect(u).toEqual({ id: "u1", email: "user@fleet.com", role: "fleet_admin", partnerId: "p1" });
    const update = dbController.updates.find((x) => x.table === users);
    expect(update?.set.lastLoginAt).toBeInstanceOf(Date);
  });

  it("throws for an email with no user row and not on ALLOWED_EMAILS", async () => {
    // Defence in depth: even a minted link for an unknown email is refused here.
    await expect(findOrCreateUser("stranger@evil.com")).rejects.toThrow(
      /not on the platform/,
    );
    expect(dbController.inserts).toHaveLength(0); // nothing was created
  });

  it("bootstraps the FIRST user as super_admin", async () => {
    // Founder bootstrap: the first env-allowlisted login becomes super_admin.
    process.env.ALLOWED_EMAILS = "founder@x.com";
    dbController.userCount = 0;
    dbController.insertReturningRows = [
      { id: "u1", email: "founder@x.com", role: "super_admin", partnerId: null },
    ];
    const u = await findOrCreateUser("Founder@X.com");
    expect(u.role).toBe("super_admin");
    const insert = dbController.inserts.find((x) => x.table === users);
    expect(insert?.values.email).toBe("founder@x.com"); // normalized to lowercase
    expect(insert?.values.role).toBe("super_admin");
    expect(insert?.values.invitedBy).toBe("bootstrap");
  });

  it("creates later env-allowlisted users as fleet_user, never super_admin", async () => {
    // Escalation guard: only the FIRST user is super_admin; later ones are fleet_user.
    process.env.ALLOWED_EMAILS = "founder@x.com,second@x.com";
    dbController.userCount = 1;
    dbController.insertReturningRows = [
      { id: "u2", email: "second@x.com", role: "fleet_user", partnerId: null },
    ];
    const u = await findOrCreateUser("second@x.com");
    expect(u.role).toBe("fleet_user");
    const insert = dbController.inserts.find((x) => x.table === users);
    expect(insert?.values.role).toBe("fleet_user");
    expect(insert?.values.invitedBy).toBe("env_allowlist");
  });
});

// Magic links — create + consume (single-use, 15-min TTL)
describe("createMagicLinkToken", () => {
  it("persists a lowercased email with a 15-minute expiry and returns the token", async () => {
    // Pin the TTL at exactly now+15min so a change is a conscious decision.
    const now = new Date("2026-06-10T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const token = await createMagicLinkToken("User@Example.com");
    const insert = dbController.inserts.find((x) => x.table === magicLinks);
    expect(insert?.values.token).toBe(token);
    expect(insert?.values.email).toBe("user@example.com");
    expect(insert?.values.expiresAt).toEqual(new Date(now.getTime() + 15 * 60 * 1000));
  });

  it("generates unguessable, unique tokens (32 random bytes, base64url)", async () => {
    // Entropy stops link-guessing: 43 base64url chars = 256 bits, and unique.
    const a = await createMagicLinkToken("a@x.com");
    const b = await createMagicLinkToken("a@x.com");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("consumeMagicLinkToken", () => {
  it("returns null for an unknown token", async () => {
    // Guessing tokens must yield nothing — no row, no login.
    dbController.magicLinkRows = [];
    await expect(consumeMagicLinkToken("no-such-token")).resolves.toBeNull();
  });

  it("rejects an already-used token (single-use property)", async () => {
    // Replay protection: a leaked link can't be reused; no second usedAt write.
    dbController.magicLinkRows = [
      { token: "tok", email: "a@x.com", usedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    ];
    await expect(consumeMagicLinkToken("tok")).resolves.toBeNull();
    expect(dbController.updates).toHaveLength(0);
  });

  it("rejects an expired token", async () => {
    // The 15-minute window is enforced at consume time, not just at mint.
    dbController.magicLinkRows = [
      { token: "tok", email: "a@x.com", usedAt: null, expiresAt: new Date(Date.now() - 1000) },
    ];
    await expect(consumeMagicLinkToken("tok")).resolves.toBeNull();
    expect(dbController.updates).toHaveLength(0);
  });

  it("consumes a fresh token: returns the email and marks usedAt", async () => {
    // Happy path; the usedAt write is what enforces single-use next time.
    dbController.magicLinkRows = [
      { token: "tok", email: "a@x.com", usedAt: null, expiresAt: new Date(Date.now() + 60_000) },
    ];
    await expect(consumeMagicLinkToken("tok")).resolves.toBe("a@x.com");
    const update = dbController.updates.find((x) => x.table === magicLinks);
    expect(update?.set.usedAt).toBeInstanceOf(Date);
  });

  it("accepts a token at the exact expiry instant (strict < comparison)", async () => {
    // Boundary: expiresAt === now is valid (check is `expiresAt < now`).
    const now = new Date("2026-06-10T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    dbController.magicLinkRows = [
      { token: "tok", email: "a@x.com", usedAt: null, expiresAt: new Date(now.getTime()) },
    ];
    await expect(consumeMagicLinkToken("tok")).resolves.toBe("a@x.com");
  });
});

// createSession / destroySession
describe("createSession", () => {
  it("persists a 14-day session row and sets a signed, httpOnly cookie", async () => {
    // Cookie flags ARE the security posture: httpOnly (XSS), sameSite=lax
    // (CSRF), expiry matching the row.
    const now = new Date("2026-06-10T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await createSession("User@Example.com");

    const insert = dbController.inserts.find((x) => x.table === authSessions);
    expect(insert?.values.email).toBe("user@example.com");
    expect(insert?.values.expiresAt).toEqual(new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000));

    const call = cookieController.setCalls[0];
    expect(call.name).toBe(AUTH_COOKIE_NAME);
    expect(call.options.httpOnly).toBe(true);
    expect(call.options.sameSite).toBe("lax");
    expect(call.options.path).toBe("/");
    expect(call.options.expires).toEqual(insert?.values.expiresAt);
    // Outside production the secure flag is off (localhost is http).
    expect(call.options.secure).toBe(false);
  });

  it("sets a cookie that verifies back to the inserted session id", async () => {
    // The cookie we hand the browser must round-trip to the exact DB session id.
    await createSession("a@x.com");
    const insert = dbController.inserts.find((x) => x.table === authSessions);
    const call = cookieController.setCalls[0];
    expect(verifyAndExtractSessionId(call.value)).toBe(insert?.values.id);
  });

  it("marks the cookie Secure in production", async () => {
    // In production the session cookie must never travel over plain http.
    vi.stubEnv("NODE_ENV", "production");
    await createSession("a@x.com");
    expect(cookieController.setCalls[0].options.secure).toBe(true);
  });

  it("throws loudly when AUTH_SECRET is missing (no unsigned cookie)", async () => {
    // Better a 500 at login than a silently unsigned/forgeable cookie.
    delete process.env.AUTH_SECRET;
    await expect(createSession("a@x.com")).rejects.toThrow(/AUTH_SECRET/);
  });
});

describe("destroySession", () => {
  it("deletes the DB session row and the cookie for a valid session", async () => {
    // Logout revokes server-side, not just the browser, so a stolen cookie dies.
    cookieController.jar.set(AUTH_COOKIE_NAME, sign("sess-1"));
    await destroySession();
    expect(dbController.deletes.some((d) => d.table === authSessions)).toBe(true);
    expect(cookieController.deleted).toContain(AUTH_COOKIE_NAME);
  });

  it("does not touch the DB for a tampered cookie, but still clears it", async () => {
    // An unverified cookie must not drive a DB delete, yet is still cleared.
    cookieController.jar.set(AUTH_COOKIE_NAME, "sess-1.forged-signature-aaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await destroySession();
    expect(dbController.deletes).toHaveLength(0);
    expect(cookieController.deleted).toContain(AUTH_COOKIE_NAME);
  });

  it("is a no-op DB-wise when there is no cookie at all", async () => {
    // Logout with no session (double-logout, expired browser) must not throw.
    await destroySession();
    expect(dbController.deletes).toHaveLength(0);
    expect(cookieController.deleted).toContain(AUTH_COOKIE_NAME);
  });
});

// getCurrentUser — session → user resolution
describe("getCurrentUser", () => {
  it("returns null when no cookie is present", async () => {
    // Anonymous request → no user, no DB lookup blows up.
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns null for a forged cookie without consulting session rows", async () => {
    // HMAC gate runs before DB trust: a forged cookie resolves no user even
    // if a matching session row exists.
    dbController.sessionRows = [
      { id: "sess-1", email: "a@x.com", expiresAt: new Date(Date.now() + 60_000) },
    ];
    cookieController.jar.set(AUTH_COOKIE_NAME, "sess-1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns null when the session row does not exist (revoked)", async () => {
    // Revocation: a valid cookie whose row was deleted must not authenticate.
    cookieController.jar.set(AUTH_COOKIE_NAME, sign("sess-1"));
    dbController.sessionRows = [];
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns null for an expired session and deletes the stale row", async () => {
    // 14-day TTL enforced on read; the dead row is GC'd (no zombies).
    cookieController.jar.set(AUTH_COOKIE_NAME, sign("sess-1"));
    dbController.sessionRows = [
      { id: "sess-1", email: "a@x.com", expiresAt: new Date(Date.now() - 1000) },
    ];
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(dbController.deletes.some((d) => d.table === authSessions)).toBe(true);
  });

  it("returns null and kills the session when the user row was deleted", async () => {
    // Offboarding: deleting a user ends live sessions on the next request.
    cookieController.jar.set(AUTH_COOKIE_NAME, sign("sess-1"));
    dbController.sessionRows = [
      { id: "sess-1", email: "gone@x.com", expiresAt: new Date(Date.now() + 60_000) },
    ];
    dbController.usersRows = [];
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(dbController.deletes.some((d) => d.table === authSessions)).toBe(true);
  });

  it("returns the CURRENT user record (fresh role/partner, not cookie-era)", async () => {
    // Role/partner re-read every call, so a demotion takes effect immediately.
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_admin", partnerId: "p1" });
    await expect(getCurrentUser()).resolves.toEqual({
      id: "u1",
      email: "a@x.com",
      role: "fleet_admin",
      partnerId: "p1",
    });
  });

  it("DISABLE_AUTH=true short-circuits to a synthetic super_admin", async () => {
    // Demo escape hatch, pinned so it stays visible; never ship it enabled.
    process.env.DISABLE_AUTH = "true";
    const u = await getCurrentUser();
    expect(u?.role).toBe("super_admin");
    expect(u?.id).toBe("demo-mode-no-auth");
  });

  it("DISABLE_AUTH with any other value does NOT bypass auth", async () => {
    // Only the exact string "true" disables auth — "1"/"yes" etc. stay safe.
    process.env.DISABLE_AUTH = "1";
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

// RBAC guards — requireUser / requireSuperAdmin / requirePartner*
describe("requireUser", () => {
  it("redirects anonymous visitors to /login", async () => {
    // Base guard: no session → bounced to login, page code never runs.
    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("returns the session user when authenticated", async () => {
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_user", partnerId: "p1" });
    await expect(requireUser()).resolves.toMatchObject({ id: "u1", role: "fleet_user" });
  });
});

describe("requireSuperAdmin", () => {
  it("redirects unauthenticated visitors to /login", async () => {
    // Admin pages inherit the base guard first.
    await expect(requireSuperAdmin()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("redirects a fleet_admin home — no vertical escalation", async () => {
    // The highest fleet role still cannot reach platform-admin pages.
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_admin", partnerId: "p1" });
    await expect(requireSuperAdmin()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("admits a super_admin", async () => {
    loginAs({ id: "u1", email: "root@x.com", role: "super_admin", partnerId: null });
    await expect(requireSuperAdmin()).resolves.toMatchObject({ role: "super_admin" });
  });
});

describe("requirePartnerAccess", () => {
  it("admits a super_admin to any partner", async () => {
    // Operations override: super admins are unscoped by design.
    loginAs({ id: "u1", email: "root@x.com", role: "super_admin", partnerId: null });
    await expect(requirePartnerAccess("p-any")).resolves.toMatchObject({ role: "super_admin" });
  });

  it("admits a fleet user to their own partner", async () => {
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_user", partnerId: "p1" });
    await expect(requirePartnerAccess("p1")).resolves.toMatchObject({ partnerId: "p1" });
  });

  it("redirects a fleet user reaching for ANOTHER partner's page", async () => {
    // Horizontal escalation guard: cross-tenant reads bounce home.
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_user", partnerId: "p1" });
    await expect(requirePartnerAccess("p2")).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("redirects a fleet user with NO partner assigned", async () => {
    // partnerId=null must never accidentally equal any real partner id.
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_user", partnerId: null });
    await expect(requirePartnerAccess("p1")).rejects.toThrow("NEXT_REDIRECT:/");
  });
});

describe("requirePartnerWrite", () => {
  it("admits a super_admin", async () => {
    loginAs({ id: "u1", email: "root@x.com", role: "super_admin", partnerId: null });
    await expect(requirePartnerWrite("p-any")).resolves.toMatchObject({ role: "super_admin" });
  });

  it("admits a fleet_admin writing to their own partner", async () => {
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_admin", partnerId: "p1" });
    await expect(requirePartnerWrite("p1")).resolves.toMatchObject({ role: "fleet_admin" });
  });

  it("redirects a fleet_admin writing to a DIFFERENT partner", async () => {
    // Admin of fleet A must not mutate fleet B's config.
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_admin", partnerId: "p1" });
    await expect(requirePartnerWrite("p2")).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("redirects a fleet_user even for their OWN partner (read-only role)", async () => {
    // Read/write split: fleet_user passes Access but never Write (no escalation).
    loginAs({ id: "u1", email: "a@x.com", role: "fleet_user", partnerId: "p1" });
    await expect(requirePartnerWrite("p1")).rejects.toThrow("NEXT_REDIRECT:/");
  });
});
