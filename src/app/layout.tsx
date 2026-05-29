import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth";

export const metadata = {
  title: "The Exchange",
  description: "The booking exchange for transport networks.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  const isSuper = user?.role === "super_admin";

  return (
    <html lang="en">
      <body className="min-h-screen bg-surface-muted text-ink">
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
