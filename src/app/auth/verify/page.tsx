import { redirect } from "next/navigation";

/**
 * Legacy path. Magic links now point at /api/auth/verify (a Route Handler)
 * because Server Components can't set cookies. This page exists only to
 * redirect anyone who hits an old URL.
 */
export default function LegacyVerifyPage() {
  redirect("/login?error=link_expired");
}
