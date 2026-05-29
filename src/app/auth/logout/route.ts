import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

/**
 * POST /auth/logout — destroys the session and redirects to /login.
 * Form-based logout from the nav, no JSON.
 */

export async function POST(req: Request) {
  await destroySession();
  const url = new URL("/login", req.url);
  return NextResponse.redirect(url, { status: 303 });
}
