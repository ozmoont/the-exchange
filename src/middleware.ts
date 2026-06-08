import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Auth middleware. Verifies the HMAC on the session cookie cheaply (Web
 * Crypto, Edge runtime). If missing or tampered, redirect to /login.
 *
 * Note: HMAC verification proves the cookie value came from us. The DB
 * lookup for session expiry happens in pages via `getCurrentUser()` — by
 * then we've already screened out obvious tampering and unauthenticated
 * requests at the edge.
 *
 * Webhook routes (`/api/webhooks/*`) are exempt — they're authenticated
 * separately via signed payloads (see ICABBI_WEBHOOK_SECRET).
 */

const COOKIE_NAME = "exchange_session";

const PUBLIC_PREFIXES = [
  "/login",
  "/signup",       // self-service partner application — accessible without auth
  "/auth/",
  "/api/auth/",
  "/api/webhooks/",
  "/api/cron/",     // Vercel cron — authenticates via x-vercel-cron / Bearer
  "/api/icabbi/",   // H1.5 inbound from iCabbi — Bearer token auth at the route level
  "/api/health",
  "/status",        // P1-O1 public status page — aggregate metrics only, no PII
  "/_next/",
  "/favicon",
];

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Demo / pre-pilot escape hatch — set DISABLE_AUTH=true in Vercel env vars
  // to remove all auth checks. Flip back to false (or remove the var) when
  // ready to require sign-in again.
  if (process.env.DISABLE_AUTH === "true") {
    return NextResponse.next();
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.replace(/\/$/, ""))) {
    return NextResponse.next();
  }

  const cookieValue = req.cookies.get(COOKIE_NAME)?.value;
  if (!cookieValue) return redirectToLogin(req, pathname);

  const valid = await isValidCookie(cookieValue);
  if (!valid) return redirectToLogin(req, pathname);

  return NextResponse.next();
}

function redirectToLogin(req: NextRequest, originalPath: string) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (originalPath && originalPath !== "/") {
    url.searchParams.set("next", originalPath);
  }
  return NextResponse.redirect(url);
}

async function isValidCookie(value: string): Promise<boolean> {
  const dot = value.lastIndexOf(".");
  if (dot < 0) return false;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!id || !sig) return false;

  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false;
  }

  const expectedBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(id)),
  );
  const expected = base64UrlEncode(expectedBytes);
  return constantTimeEqual(sig, expected);
}

function base64UrlEncode(bytes: Uint8Array): string {
  // Standard base64 then URL-safe transform, matching Node's `base64url`
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
