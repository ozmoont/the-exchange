import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth";
import { maybeTickDemoMode } from "@/lib/demo";

export const metadata = {
  title: "The Exchange",
  description: "The booking exchange for transport networks.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Demo-mode background activity — ticks one transit forward every 20s.
  // No-op when DISABLE_AUTH != true. Costs one SELECT on every other page
  // render at steady state; fires the work when the cooldown elapses.
  await maybeTickDemoMode();

  const user = await getCurrentUser();
  const isSuper = user?.role === "super_admin";

  // P0-1: Persistent banner when DISABLE_AUTH is on. The escape hatch is
  // necessary for demos but easy to forget about — this banner makes it
  // impossible to miss. Always render at the very top, regardless of auth.
  const authDisabled = process.env.DISABLE_AUTH === "true";
  if (authDisabled && process.env.NODE_ENV === "production") {
    console.warn(
      "[BOOT WARNING] DISABLE_AUTH=true in production. Every visitor is " +
        "super_admin. Set DISABLE_AUTH=false (or remove the var) to require " +
        "sign-in.",
    );
  }

  return (
    <html lang="en">
      <body className="min-h-screen bg-surface-muted text-ink">
        {authDisabled && (
          <div
            role="alert"
            className="bg-danger text-danger-fg px-4 py-2 text-center text-xs font-semibold tracking-wide border-b border-red-300"
          >
            ⚠️ DEMO MODE — auth is disabled (DISABLE_AUTH=true). Anyone with the
            URL is treated as super_admin. Remove the env var before letting
            real partners connect.
          </div>
        )}
        {user && (
          <header className="bg-surface-inverse text-white">
            <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-6">
              <Link href="/" className="font-bold tracking-tight text-base">
                The Exchange
              </Link>
              <nav className="hidden sm:flex items-center gap-5 text-sm text-white/80">
                <Link href="/" className="hover:text-white">Overview</Link>
                <Link href="/partners" className="hover:text-white">Partners</Link>
                <Link href="/rules" className="hover:text-white">Routing</Link>
                {isSuper && <Link href="/fees" className="hover:text-white">Fees</Link>}
                <Link href="/bookings" className="hover:text-white">Bookings</Link>
                {isSuper && <Link href="/distribution" className="hover:text-white">Distribution</Link>}
                {isSuper && <Link href="/signups" className="hover:text-white">Signups</Link>}
                {isSuper && <Link href="/audit" className="hover:text-white">Audit</Link>}
                {isSuper && <Link href="/webhooks" className="hover:text-white">Webhooks</Link>}
                {isSuper && <Link href="/users" className="hover:text-white">Users</Link>}
              </nav>
              <div className="ml-auto flex items-center gap-3">
                <span className="hidden sm:inline text-xs text-white/60">
                  {user.email} · <span className="uppercase tracking-wide">{user.role.replace("_", " ")}</span>
                </span>
                <form action="/auth/logout" method="post">
                  <button
                    type="submit"
                    className="text-xs px-3 py-1 rounded border border-white/20 hover:bg-white/10 transition-colors"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </header>
        )}
        <main className={user ? "mx-auto max-w-7xl px-6 py-8" : ""}>{children}</main>
      </body>
    </html>
  );
}
