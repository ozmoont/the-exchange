import Link from "next/link";
import { db } from "@/db/client";
import { partners, transits, networkControls, auditLog } from "@/db/schema";
import { count, desc, eq, gte } from "drizzle-orm";
import { setKillSwitch } from "@/lib/routing";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { LiveRefresh } from "@/components/live-refresh";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) return <LandingPage />;
  return (
    <Dashboard
      userEmail={user.email}
      isSuperAdmin={user.role === "super_admin"}
      scopedPartnerId={user.partnerId}
    />
  );
}

// ---------------------------------------------------------------------------
// Landing page — what unauthenticated visitors see
// ---------------------------------------------------------------------------

function LandingPage() {
  return (
    <div className="min-h-screen bg-surface-muted">
      <header className="border-b border-border bg-white">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-accent" aria-hidden="true" />
            <span className="font-bold tracking-tight">The Exchange</span>
          </div>
          <Link href="/login" className="btn-primary">Sign in</Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-20 grid md:grid-cols-2 gap-10 items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold mb-4">
            Booking exchange for transport networks
          </p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-tight">
            One network. Many fleets. Every booking accounted for.
          </h1>
          <p className="mt-5 text-lg text-ink-muted max-w-xl leading-relaxed">
            The Exchange connects iCabbi fleets and external partners into a single,
            auditable booking network. Fleets choose who they work with. Bookings
            flow with their fees attached. Every event is logged.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className="btn-primary">Sign in</Link>
            <Link href="/login" className="btn-secondary">Request access</Link>
          </div>
          <p className="mt-5 text-xs text-ink-subtle">
            Access is allowlist-only. Ask the founder if you should be on it.
          </p>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-xs text-ink-subtle">Network status</div>
              <div className="text-sm font-semibold text-success-fg flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success-fg" /> All systems routing
              </div>
            </div>
            <span className="badge-info">live</span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <MiniStat label="Active partners" value="14" />
            <MiniStat label="Today" value="312" />
            <MiniStat label="Completed" value="289" />
          </div>
          <div className="space-y-2 text-xs">
            <Row a="Dublin Cabs" b="Cork Express" status="completed" />
            <Row a="CMAC" b="Dublin Cabs" status="on_board" />
            <Row a="Cork Express" b="Galway Taxis" status="en_route" />
            <Row a="Dublin Cabs" b="CMAC" status="accepted" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16 border-t border-border">
        <h2 className="text-2xl font-bold tracking-tight">How it works</h2>
        <div className="mt-8 grid md:grid-cols-3 gap-6">
          <FeatureCard
            number="1"
            title="Connect your fleet"
            body="iCabbi fleets connect with their App-Key and Secret-Key. External partners (CMAC, FreeNow) plug in via the same adapter pattern. Every credential encrypted at rest."
          />
          <FeatureCard
            number="2"
            title="Choose who you work with"
            body="A bilateral allow/block matrix means routing only happens with mutual consent. You decide who can send you work and who you'll send work to."
          />
          <FeatureCard
            number="3"
            title="Bookings carry their fees"
            body="Per-partner network and trip fees travel with the booking payload. Required for King County WAV and Blue Line affiliate billing — and a clean audit trail every time."
          />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16 border-t border-border">
        <h2 className="text-2xl font-bold tracking-tight">Built for operators, not consumers</h2>
        <div className="mt-6 grid md:grid-cols-2 gap-6 text-sm text-ink-muted">
          <div>
            <strong className="text-ink">Every event audited.</strong> Partner registrations, rule
            changes, fee updates, kill-switch toggles — all logged immutably with actor and timestamp.
          </div>
          <div>
            <strong className="text-ink">HMAC-signed webhooks.</strong> Per-partner webhook secrets,
            SHA-512 verification on the raw body, no shared global secret.
          </div>
          <div>
            <strong className="text-ink">Encrypted credentials.</strong> AES-256-GCM at rest. A
            database dump doesn&apos;t leak App-Keys or Secret-Keys.
          </div>
          <div>
            <strong className="text-ink">Network kill switch.</strong> One button halts all new
            bookings instantly. In-flight bookings continue receiving status updates so nothing
            strands.
          </div>
        </div>
      </section>

      <footer className="border-t border-border py-8 mt-8">
        <div className="mx-auto max-w-7xl px-6 text-xs text-ink-subtle flex items-center justify-between">
          <span>The Exchange · Built in Dublin</span>
          <Link href="/login" className="hover:text-ink">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-muted px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function Row({ a, b, status }: { a: string; b: string; status: string }) {
  const tone =
    status === "completed"
      ? "badge-success"
      : ["en_route", "on_board", "accepted"].includes(status)
      ? "badge-info"
      : "badge-neutral";
  return (
    <div className="flex items-center justify-between py-1 border-b border-border last:border-0">
      <span className="text-ink-muted">
        {a} <span className="text-ink-subtle">→</span> {b}
      </span>
      <span className={tone}>{status.replace("_", " ")}</span>
    </div>
  );
}

function FeatureCard({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="card p-5">
      <div className="text-3xl font-bold text-accent">{number}</div>
      <h3 className="mt-2 font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed-in dashboard
// ---------------------------------------------------------------------------

async function Dashboard({
  userEmail,
  isSuperAdmin,
  scopedPartnerId,
}: {
  userEmail: string;
  isSuperAdmin: boolean;
  scopedPartnerId: string | null;
}) {
  const partnerCountRows = await db
    .select({ n: count() })
    .from(partners)
    .where(eq(partners.status, "active"));
  const partnerCount = Number(partnerCountRows[0]?.n ?? 0);

  const transitStatsRows = scopedPartnerId
    ? await db
        .select({ status: transits.status, n: count() })
        .from(transits)
        .where(eq(transits.originatorPartnerId, scopedPartnerId))
        .groupBy(transits.status)
    : await db
        .select({ status: transits.status, n: count() })
        .from(transits)
        .groupBy(transits.status);

  const pushedToday = Number(transitStatsRows.find((s) => s.status === "pushed")?.n ?? 0);
  const completed = Number(transitStatsRows.find((s) => s.status === "completed")?.n ?? 0);
  const failed =
    Number(transitStatsRows.find((s) => s.status === "failed")?.n ?? 0) +
    Number(transitStatsRows.find((s) => s.status === "no_match")?.n ?? 0);

  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  const killOn = control?.killSwitch ?? false;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentTransits = scopedPartnerId
    ? await db
        .select()
        .from(transits)
        .where(eq(transits.originatorPartnerId, scopedPartnerId))
        .orderBy(desc(transits.createdAt))
        .limit(8)
    : await db
        .select()
        .from(transits)
        .where(gte(transits.createdAt, since))
        .orderBy(desc(transits.createdAt))
        .limit(8);

  const recentEvents = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(6);

  async function toggleKill() {
    "use server";
    await setKillSwitch(!killOn, killOn ? "manual_off" : "manual_on", userEmail);
    revalidatePath("/");
  }

  return (
    <div className="space-y-8">
      <LiveRefresh interval={10000} />
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            {isSuperAdmin ? "Network overview" : "Your fleet"}
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">
            {isSuperAdmin ? "All systems routing" : "Welcome back"}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/partners" className="btn-secondary">
            {isSuperAdmin ? "Manage partners" : "Your partner"}
          </Link>
          {isSuperAdmin && (
            <Link href="/users" className="btn-secondary">Invite users</Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label={isSuperAdmin ? "Active partners" : "Connections"} value={partnerCount} />
        <StatCard label="Pushed" value={pushedToday} tone="info" />
        <StatCard label="Completed" value={completed} tone="success" />
        <StatCard label="Failed / no match" value={failed} tone={failed > 0 ? "danger" : "neutral"} />
      </div>

      {isSuperAdmin && (
        <section className={`card p-5 ${killOn ? "bg-red-50 border-red-200" : ""}`}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-muted font-semibold">
                Network kill switch
              </div>
              <div className={`text-lg font-bold mt-1 ${killOn ? "text-red-700" : "text-ink"}`}>
                {killOn ? "Engaged — new bookings paused" : "Off — routing live"}
              </div>
              <p className="text-sm text-ink-muted mt-1 max-w-2xl">
                When engaged, every new booking is held at <code>paused</code> status. In-flight
                transits continue receiving status updates so nothing strands.
              </p>
            </div>
            <form action={toggleKill}>
              <button type="submit" className={killOn ? "btn-secondary" : "btn-danger"}>
                {killOn ? "Disengage" : "Engage kill switch"}
              </button>
            </form>
          </div>
        </section>
      )}

      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2 card">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold">Recent activity</h2>
            <Link href="/bookings" className="text-xs text-ink-muted hover:text-ink">View all →</Link>
          </div>
          {recentTransits.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-muted">
              No transits in the last 24h.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {recentTransits.map((t) => (
                <li key={t.id} className="px-5 py-3 flex items-center justify-between text-sm">
                  <Link href={`/transits/${t.id}`} className="text-ink hover:underline">
                    <code className="text-xs text-ink-subtle">{t.originatorBookingExternalId}</code>
                  </Link>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-ink-muted">{new Date(t.createdAt).toLocaleTimeString()}</span>
                    <span className={statusTone(t.status)}>{t.status.replace(/_/g, " ")}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isSuperAdmin && (
          <div className="card">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-semibold">Audit log</h2>
              <Link href="/audit" className="text-xs text-ink-muted hover:text-ink">All →</Link>
            </div>
            {recentEvents.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-muted">No events yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {recentEvents.map((e) => (
                  <li key={e.id} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between text-xs text-ink-muted">
                      <span className={categoryTone(e.category)}>{e.category}</span>
                      <span>{relativeTime(e.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-ink">
                      <code className="text-xs">{e.action}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "info" | "success" | "danger" | "neutral";
}) {
  const bg =
    tone === "success"
      ? "bg-success/40"
      : tone === "info"
      ? "bg-info/40"
      : tone === "danger"
      ? "bg-danger/40"
      : "";
  return (
    <div className={`stat ${bg}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value.toLocaleString()}</div>
    </div>
  );
}

function statusTone(status: string) {
  if (status === "completed") return "badge-success";
  if (status === "cancelled" || status === "failed" || status === "no_match" || status.startsWith("error_")) return "badge-danger";
  if (status === "paused") return "badge-warning";
  if (["pushed", "accepted", "driver_assigned", "en_route", "on_board"].includes(status)) return "badge-info";
  return "badge-neutral";
}

function categoryTone(cat: string) {
  if (cat === "credential") return "badge-danger";
  if (cat === "permission") return "badge-success";
  if (cat === "fee") return "badge-info";
  if (cat === "admin") return "badge-warning";
  return "badge-neutral";
}

function relativeTime(d: Date | string) {
  const sec = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
