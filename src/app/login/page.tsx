import { redirect } from "next/navigation";
import {
  createMagicLinkToken,
  getCurrentUser,
  isEmailAllowed,
} from "@/lib/auth";
import { sendMagicLinkEmail } from "@/lib/email";
import {
  checkRateLimit,
  LIMIT_MAGIC_LINK_PER_EMAIL,
  WINDOW_MAGIC_LINK_SECONDS,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public sign-in page. Asks for email, sends a magic link if the email is
 * on the allowlist. Doesn't disclose whether an email is allowed — we
 * always claim "if your email is on the list, a link has been sent".
 */

async function sendLinkAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const nextPath = String(formData.get("next") ?? "");

  if (!email) {
    redirect("/login?error=missing_email");
  }

  // P0-4: rate limit magic-link requests per email. Stops a malicious actor
  // from spamming someone's inbox with sign-in links. Limit + window tunable
  // via env vars.
  const rl = await checkRateLimit(
    `magic_link:${email}`,
    Number(process.env.MAGIC_LINK_RATE_LIMIT ?? LIMIT_MAGIC_LINK_PER_EMAIL),
    WINDOW_MAGIC_LINK_SECONDS,
  );
  if (!rl.ok) {
    // Don't tell the requester they hit the limit (would leak that the email
    // is on the allowlist). Show the same "if your email is on the list, a
    // link has been sent" message as the happy path.
    console.warn(`[auth] rate-limited magic-link request for ${email}`);
    redirect("/login?sent=1");
  }

  if (await isEmailAllowed(email)) {
    const token = await createMagicLinkToken(email);
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const url = new URL("/api/auth/verify", appUrl);
    url.searchParams.set("token", token);
    if (nextPath) url.searchParams.set("next", nextPath);
    // A delivery failure (e.g. Resend rejecting an unverified sender) must not
    // crash the sign-in page. Swallow it and fall through to the same neutral
    // "link sent" response — surfacing it would both 500 the page and leak that
    // this address is on the allowlist. Log for ops; never log the token/URL.
    try {
      await sendMagicLinkEmail({ to: email, url: url.toString() });
    } catch (err) {
      console.error(
        `[auth] magic-link email failed to send for ${email}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.warn(`[auth] Login attempt for non-allowlisted email: ${email}`);
  }

  redirect("/login?sent=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  const sp = await searchParams;
  const sent = sp.sent === "1";
  const error = sp.error;
  const next = sp.next ?? "";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="h-8 w-8 rounded-md bg-accent" aria-hidden="true" />
          <span className="font-bold tracking-tight text-lg">The Exchange</span>
        </div>

        <div className="card p-8">
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            Sign in
          </p>
          <h1 className="text-2xl font-bold tracking-tight mt-2">
            {sent ? "Check your email" : "Welcome back"}
          </h1>

          {sent ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-md bg-success px-4 py-3 text-sm text-success-fg">
                If that email is on the allowlist, a sign-in link has been sent.
                Open it from the same browser within 15 minutes.
              </div>
              <p className="text-xs text-ink-muted">
                Running locally? The link is printed to the dev server&apos;s terminal —
                look for the boxed <code>MAGIC LINK</code> banner.
              </p>
              <a href="/login" className="text-sm text-accent hover:underline">
                Send another →
              </a>
            </div>
          ) : (
            <form action={sendLinkAction} className="mt-6 space-y-4">
              {next && <input type="hidden" name="next" value={next} />}
              <div>
                <label htmlFor="email" className="label">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="input"
                />
              </div>
              {error === "missing_email" && (
                <p className="text-xs text-red-700">Email is required.</p>
              )}
              {error === "invalid_token" && (
                <p className="text-xs text-red-700">
                  That sign-in link has expired or was already used. Send another below.
                </p>
              )}
              {error === "not_on_platform" && (
                <p className="text-xs text-red-700">
                  Your account isn&apos;t on the platform. Ask a super admin to invite you.
                </p>
              )}
              <button type="submit" className="btn-primary w-full justify-center">
                Send sign-in link
              </button>
              <p className="text-xs text-ink-muted">
                You&apos;ll get a one-time link that signs you in. Access is invite-only.
              </p>
            </form>
          )}
        </div>

        {!sent && (
          <div className="card p-5 mt-4 text-center">
            <p className="text-sm text-ink-muted">
              New fleet?{" "}
              <a href="/signup" className="text-accent font-semibold hover:underline">
                Apply to join the network →
              </a>
            </p>
          </div>
        )}

        <p className="text-center text-xs text-ink-subtle mt-6">
          Booking exchange for transport networks · Built in Dublin
        </p>
      </div>
    </div>
  );
}
