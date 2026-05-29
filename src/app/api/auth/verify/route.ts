import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { consumeMagicLinkToken, createSession, findOrCreateUser } from "@/lib/auth";

/**
 * GET /api/auth/verify?token=...&next=...
 *
 * Consumes a magic-link token, ensures the user record exists (find-or-create
 * with bootstrap promotion for the first sign-in), creates a session cookie,
 * redirects to `next` or `/`.
 */

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const nextParam = req.nextUrl.searchParams.get("next") ?? "/";

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing_token", req.url));
  }

  const email = await consumeMagicLinkToken(token);
  if (!email) {
    return NextResponse.redirect(new URL("/login?error=invalid_token", req.url));
  }

  try {
    await findOrCreateUser(email);
  } catch {
    return NextResponse.redirect(new URL("/login?error=not_on_platform", req.url));
  }

  await createSession(email);

  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";
  return NextResponse.redirect(new URL(safeNext, req.url));
}
