import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { magicLinks, authSessions, users } from "@/db/schema";
import { count, eq } from "drizzle-orm";

export type SessionUser = {
  id: string;
  email: string;
  role: "super_admin" | "fleet_admin" | "fleet_user";
  partnerId: string | null;
};

/**
 * Magic-link auth with allowlist + HMAC-signed session cookies.
 *
 *   1. User submits email on /login.
 *   2. If email is on ALLOWED_EMAILS, we create a magic_links row (15-min TTL,
 *      single-use) and email a link to /auth/verify?token=...
 *   3. /auth/verify consumes the token (marks usedAt), creates an auth_sessions
 *      row (14-day TTL), sets a signed cookie, redirects to /.
 *   4. Middleware validates the cookie's HMAC on every request and redirects to
 *      /login if invalid. Pages can call `getCurrentUser()` for the email.
 *
 * Why HMAC-signed cookie + DB session: HMAC alone gives integrity (cheap edge
 * verification); the DB row gives revocation (destroy session on logout).
 */

const COOKIE_NAME = "exchange_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

function requireSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "AUTH_SECRET is not set or too short. Generate with: openssl rand -base64 32",
    );
  }
  return s;
}

function signSessionId(sessionId: string): string {
  const sig = createHmac("sha256", requireSecret()).update(sessionId).digest("base64url");
  return `${sessionId}.${sig}`;
}

export function verifyAndExtractSessionId(cookieValue: string): string | null {
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 0) return null;
  const id = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!id || !sig) return null;

  let expected: string;
  try {
    expected = createHmac("sha256", requireSecret()).update(id).digest("base64url");
  } catch {
    return null;
  }

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return id;
}

/**
 * Whether this email is on the platform — either as a real users-table row
 * OR (bootstrap-only) as the first entry in ALLOWED_EMAILS env. The
 * bootstrap path exists so the founder can sign in before any user records
 * exist; after first login they're auto-promoted into the users table as
 * super_admin.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const normalized = email.toLowerCase();
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalized));
  if (existing) return true;

  // Bootstrap: env-listed emails are still allowed in
  const bootstrap = String(process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return bootstrap.includes(normalized);
}

/**
 * Find-or-create the user record for an email. Called at the end of a
 * successful magic-link verification. Returns the persisted user.
 *
 * Bootstrap policy: if no users exist yet and the email is in ALLOWED_EMAILS,
 * the first-ever user is promoted to super_admin so the founder doesn't get
 * locked out on initial deploy.
 */
export async function findOrCreateUser(email: string): Promise<SessionUser> {
  const normalized = email.toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.email, normalized));
  if (existing) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existing.id));
    return {
      id: existing.id,
      email: existing.email,
      role: existing.role,
      partnerId: existing.partnerId,
    };
  }

  // No record yet — bootstrap or env-allowlist entry
  const bootstrap = String(process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!bootstrap.includes(normalized)) {
    throw new Error(`User ${normalized} not on the platform`);
  }

  const [{ n: existingCount }] = await db
    .select({ n: count() })
    .from(users);
  const isFirstUser = Number(existingCount) === 0;

  const [created] = await db
    .insert(users)
    .values({
      email: normalized,
      role: isFirstUser ? "super_admin" : "fleet_user",
      partnerId: null,
      invitedBy: isFirstUser ? "bootstrap" : "env_allowlist",
      lastLoginAt: new Date(),
    })
    .returning();

  return {
    id: created.id,
    email: created.email,
    role: created.role,
    partnerId: created.partnerId,
  };
}


export async function createMagicLinkToken(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await db.insert(magicLinks).values({ token, email: email.toLowerCase(), expiresAt });
  return token;
}

export async function consumeMagicLinkToken(token: string): Promise<string | null> {
  const now = new Date();
  const [row] = await db.select().from(magicLinks).where(eq(magicLinks.token, token));
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt < now) return null;
  await db.update(magicLinks).set({ usedAt: now }).where(eq(magicLinks.token, token));
  return row.email;
}

export async function createSession(email: string): Promise<void> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(authSessions).values({ id, email: email.toLowerCase(), expiresAt });
  const c = await cookies();
  c.set(COOKIE_NAME, signSessionId(id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const c = await cookies();
  const cookieValue = c.get(COOKIE_NAME)?.value;
  if (cookieValue) {
    const sessionId = verifyAndExtractSessionId(cookieValue);
    if (sessionId) {
      await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    }
  }
  c.delete(COOKIE_NAME);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const c = await cookies();
  const cookieValue = c.get(COOKIE_NAME)?.value;
  if (!cookieValue) return null;
  const sessionId = verifyAndExtractSessionId(cookieValue);
  if (!sessionId) return null;
  const [session] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId));
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    return null;
  }
  // Resolve current user record (role + partnerId may change since the cookie
  // was issued — a fleet user could be promoted, or revoked entirely)
  const [u] = await db.select().from(users).where(eq(users.email, session.email));
  if (!u) {
    // User row was deleted but session lingered — kill the session
    await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    return null;
  }
  return { id: u.id, email: u.email, role: u.role, partnerId: u.partnerId };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Redirect anyone who isn't a super admin away to their scoped home page.
 * Use at the top of admin-only pages (/users, /audit, /fees etc).
 */
export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "super_admin") redirect("/");
  return user;
}

/**
 * Gate a partner-scoped page: super admins see everything, fleet roles see
 * only their own partner. Anyone else accessing a partner that isn't theirs
 * gets bounced home.
 */
export async function requirePartnerAccess(partnerId: string): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role === "super_admin") return user;
  if (user.partnerId === partnerId) return user;
  redirect("/");
}

/**
 * Like requirePartnerAccess but for *write* operations — only super_admin or
 * fleet_admin (not fleet_user) can mutate config for their partner.
 */
export async function requirePartnerWrite(partnerId: string): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role === "super_admin") return user;
  if (user.role === "fleet_admin" && user.partnerId === partnerId) return user;
  redirect("/");
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
