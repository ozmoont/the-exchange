/**
 * Authentication for iCabbi-tenant inbound API calls.
 *
 * iCabbi acts as a fleet-side caller when offering us overflow bookings
 * (per BDD Epic 2 / decision #12 in STRATEGY.md). They authenticate via
 * a Bearer token we issue when the integration is set up. The token is
 * stored in encrypted partners.credentials.inboundBearerToken.
 *
 * Resolving: given a request, find the partner whose Bearer token matches.
 * Constant-time comparison to prevent timing attacks. Token never appears
 * in logs.
 */

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptIfNeeded } from "@/lib/crypto";
import { timingSafeEqual } from "node:crypto";

export type AuthenticatedPartner = {
  id: string;
  name: string;
  adapterKey: string;
  kind: string;
};

export type AuthResult =
  | { ok: true; partner: AuthenticatedPartner }
  | { ok: false; status: 401 | 400; error: string };

const BEARER_PREFIX = "Bearer ";

/**
 * Resolve the Bearer token in the Authorization header to a partner row.
 *
 * Returns { ok: true, partner } on a match. Returns { ok: false, status, error }
 * on missing / malformed / unknown token. Never throws.
 *
 * Implementation note: we have to scan partners and constant-time-compare
 * because tokens are encrypted at rest with a per-key IV — we can't query by
 * the encrypted value. Acceptable at our scale (<1000 partners). At 10k+ we'd
 * keep a separate prefix index in plaintext and look up by the first 12 chars.
 */
export async function authenticateInboundCaller(
  authHeader: string | null,
): Promise<AuthResult> {
  if (!authHeader) {
    return { ok: false, status: 401, error: "missing_authorization" };
  }
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return { ok: false, status: 401, error: "invalid_authorization_scheme" };
  }
  const provided = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!provided) {
    return { ok: false, status: 401, error: "missing_token" };
  }

  // Reasonable shape check before walking the partner table — Bearer tokens
  // we issue are 48-byte base64url. ~64 chars. Reject obviously bad inputs
  // without an O(n) DB scan.
  if (provided.length < 32 || provided.length > 256) {
    return { ok: false, status: 401, error: "invalid_token_format" };
  }

  // Scan partners with stored credentials. In practice only iCabbi-kind
  // partners that have been "Connected" via the integration UI will have a
  // bearer token, so this is a small set.
  const rows = await db
    .select({
      id: partners.id,
      name: partners.name,
      adapterKey: partners.adapterKey,
      kind: partners.kind,
      credentials: partners.credentials,
    })
    .from(partners)
    .where(eq(partners.kind, "icabbi_fleet"));

  for (const row of rows) {
    const creds = (decryptIfNeeded(row.credentials as Record<string, unknown> | null) ?? {}) as {
      inboundBearerToken?: string;
    };
    if (!creds.inboundBearerToken) continue;
    if (constantTimeEqual(creds.inboundBearerToken, provided)) {
      return {
        ok: true,
        partner: {
          id: row.id,
          name: row.name,
          adapterKey: row.adapterKey,
          kind: row.kind,
        },
      };
    }
  }

  return { ok: false, status: 401, error: "unknown_token" };
}

/**
 * Constant-time string compare. Returns false (not throws) when lengths
 * differ — short-circuiting on length is fine because token length is
 * not secret (we publish it as 48-byte base64url).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}
