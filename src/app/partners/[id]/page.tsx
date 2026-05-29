import { db } from "@/db/client";
import { partners, partnerRules, transits } from "@/db/schema";
import { and, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { routeBooking } from "@/lib/routing";
import { InboundWebhookSimulator } from "@/components/inbound-webhook-simulator";
import { requirePartnerAccess } from "@/lib/auth";
import { LiveRefresh } from "@/components/live-refresh";

export const dynamic = "force-dynamic";

/**
 * Per-partner page. Shows config, who they have mutual allow with, recent
 * transits, and (for editors) a "send test booking" form + inbound webhook
 * simulator. Fleet users see a read-only view.
 */

async function sendTestBookingAction(formData: FormData) {
  "use server";

  const originatorId = String(formData.get("originatorId") ?? "");
  if (!originatorId) return;

  const bookingType = (String(formData.get("bookingType") ?? "asap")) as "asap" | "prebook";
  const channel = (String(formData.get("channel") ?? "app")) as "app" | "web" | "phone" | "api";
  const vehicleType = String(formData.get("vehicleType") ?? "standard");
  const passengerCount = Number(formData.get("passengerCount") ?? 1);
  const fareRaw = String(formData.get("farePounds") ?? "").trim();
  const fareEstimatePence = fareRaw ? Math.round(Number(fareRaw) * 100) : undefined;

  const pickupAddress = String(formData.get("pickupAddress") ?? "O'Connell St, Dublin");
  const dropoffAddress = String(formData.get("dropoffAddress") ?? "Dublin Airport");

  // Default lat/lngs — in real life these come from the originator's quote
  const pickup = { lat: 53.349, lng: -6.26, address: pickupAddress };
  const dropoff = { lat: 53.421, lng: -6.27, address: dropoffAddress };

  const externalId = `TEST-${Date.now()}`;
  const scheduledFor = bookingType === "prebook" ? new Date(Date.now() + 3600_000).toISOString() : undefined;

  const result = await routeBooking({
    originatorPartnerId: originatorId,
    booking: {
      originatorBookingExternalId: externalId,
      bookingType,
      channel,
      pickup,
      dropoff,
      scheduledFor,
      vehicleType,
      passengerCount,
      fareEstimatePence,
      passenger: { name: "Test Passenger", phone: "+353 1 000 0000" },
      raw: { source: "portal_test_form" },
    },
  });

  revalidatePath("/bookings");
  revalidatePath(`/partners/${originatorId}`);
  redirect(`/bookings?highlight=${result.transitId}&outcome=${result.outcome}`);
}

export default async function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePartnerAccess(id);
  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) notFound();
  const canEdit = user.role === "super_admin" || user.role === "fleet_admin";

  const outRules = await db
    .select({ rule: partnerRules.rule, other: partners })
    .from(partnerRules)
    .innerJoin(partners, eq(partnerRules.recipientId, partners.id))
    .where(eq(partnerRules.originatorId, partner.id));

  const inRules = await db
    .select({ rule: partnerRules.rule, other: partners })
    .from(partnerRules)
    .innerJoin(partners, eq(partnerRules.originatorId, partners.id))
    .where(eq(partnerRules.recipientId, partner.id));

  const outAllowed = new Set(outRules.filter((r) => r.rule === "allow").map((r) => r.other.id));
  const mutualPartners = inRules
    .filter((r) => r.rule === "allow" && outAllowed.has(r.other.id))
    .map((r) => r.other);

  const recent = await db
    .select()
    .from(transits)
    .where(or(eq(transits.originatorPartnerId, partner.id), eq(transits.recipientPartnerId, partner.id)))
    .orderBy(desc(transits.createdAt))
    .limit(10);

  // Partner health metrics — recomputed on every render. With LiveRefresh
  // ticking the dashboard every 10s and demo mode advancing transits every
  // 20s, these numbers visibly change during a demo.
  const metrics = await computePartnerMetrics(partner.id);

  return (
    <div className="space-y-6">
      <LiveRefresh interval={10000} />
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            {partner.kind.replace("_", " ")}
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">{partner.name}</h1>
          <div className="text-xs text-ink-subtle mt-2">
            <code>{partner.id}</code> · adapter <code>{partner.adapterKey}</code>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {canEdit && (
            <Link href={`/partners/${partner.id}/edit`} className="btn-primary">
              Edit partner
            </Link>
          )}
          {partner.kind === "icabbi_fleet" && user.role === "super_admin" && (
            <Link href={`/partners/${partner.id}/integration`} className="text-sm text-ink hover:underline">
              {partner.adapterKey === "icabbi" ? "iCabbi integration ✓" : "Connect iCabbi"} →
            </Link>
          )}
          {user.role === "super_admin" && (
            <Link href={`/fees?partner=${partner.id}`} className="text-sm text-ink hover:underline">
              Manage fees →
            </Link>
          )}
          <Link href="/partners" className="text-sm text-ink-muted hover:text-ink">← All partners</Link>
        </div>
      </div>

      {/* Health metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="In flight"
          value={metrics.inFlight}
          subtitle={metrics.inFlight === 0 ? "no active transits" : metrics.inFlight === 1 ? "transit currently routing" : "transits currently routing"}
        />
        <MetricCard
          label="Completed (24h)"
          value={metrics.completed24h}
          subtitle="passenger trips delivered"
          tone="success"
        />
        <MetricCard
          label="Success rate (24h)"
          value={metrics.successRate === null ? "—" : `${metrics.successRate}%`}
          subtitle={metrics.total24h === 0 ? "no transits in last 24h" : `of ${metrics.total24h} total transits`}
          tone={metrics.successRate !== null && metrics.successRate < 80 ? "danger" : "success"}
        />
        <MetricCard
          label="Last activity"
          value={metrics.lastActivityAgo ?? "—"}
          subtitle={metrics.lastActivityAt ? new Date(metrics.lastActivityAt).toLocaleString() : "no transits yet"}
        />
      </div>

      {/* Configuration + Can route to */}
      <div className="grid md:grid-cols-2 gap-6">
        <Section title="Configuration">
          <KV k="Mode" v={partner.participationMode.replace(/_/g, " ")} />
          <KV k="Status" v={<StatusBadge status={partner.status} />} />
          <KV k="Regions" v={partner.operatingRegions.join(", ") || "—"} />
          <KV k="Vehicles" v={partner.vehicleTypes.join(", ") || "—"} />
          <KV k="Booking types" v={partner.bookingTypes.join(", ")} />
          <KV k="Contact" v={partner.contactEmail ?? "—"} />
        </Section>

        <Section title={`Can route to (${mutualPartners.length})`}>
          {mutualPartners.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No mutual allow rules yet. Visit{" "}
              <Link href="/rules" className="text-accent hover:underline">Routing</Link>{" "}
              to set them up — a new fleet won&apos;t route until both sides have an allow rule.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {mutualPartners.map((p) => (
                <li key={p.id} className="text-sm">
                  <Link href={`/partners/${p.id}`} className="text-ink hover:underline">
                    {p.name}
                  </Link>{" "}
                  <span className="text-xs text-ink-subtle">({p.kind.replace("_", " ")})</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Send test booking (editors only) */}
      {canEdit && (
        <section className="card bg-warning/60 border-yellow-400 p-5">
          <h2 className="text-base font-semibold text-yellow-900 mb-1">
            Send a test booking from this partner
          </h2>
          <p className="text-sm text-yellow-900/80 mb-4">
            Fires the routing engine with {partner.name} as the originator. Routing picks the
            lowest-receive-fee mutually-allowed partner whose vehicle and booking types match.
            Watch the result in <Link href="/bookings" className="underline">Bookings</Link>.
          </p>
          {partner.participationMode === "receive_only" || partner.participationMode === "inactive" ? (
            <div className="text-sm text-red-800">
              This partner&apos;s participation mode is <code>{partner.participationMode}</code>, so it
              can&apos;t originate bookings. Switch them to <code>send_and_receive</code> or{" "}
              <code>send_only</code> first.
            </div>
          ) : mutualPartners.length === 0 ? (
            <div className="text-sm text-red-800">
              No mutual allow rules — routing will report <code>no_match</code>. Set up at least one
              on the <Link href="/rules" className="underline">Routing</Link> page first.
            </div>
          ) : (
            <form action={sendTestBookingAction} className="grid gap-3">
              <input type="hidden" name="originatorId" value={partner.id} />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Booking type">
                  <select name="bookingType" defaultValue="asap" className="input">
                    <option value="asap">ASAP</option>
                    <option value="prebook">Pre-book (+1h)</option>
                  </select>
                </Field>
                <Field label="Channel">
                  <select name="channel" defaultValue="app" className="input">
                    <option value="app">app</option>
                    <option value="web">web</option>
                    <option value="phone">phone</option>
                    <option value="api">api</option>
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Vehicle type">
                  <input name="vehicleType" defaultValue="standard" className="input" />
                </Field>
                <Field label="Passengers">
                  <input name="passengerCount" type="number" min={1} max={8} defaultValue={1} className="input" />
                </Field>
              </div>

              <Field label="Pickup address">
                <input name="pickupAddress" defaultValue="O'Connell St, Dublin" className="input" />
              </Field>
              <Field label="Dropoff address">
                <input name="dropoffAddress" defaultValue="Dublin Airport" className="input" />
              </Field>
              <Field label="Fare estimate (£)" hint="Optional. If set, percentage-based trip fees use this as the base.">
                <input name="farePounds" type="number" step="0.5" placeholder="25.00" className="input" />
              </Field>

              <button type="submit" className="btn-primary justify-self-start mt-2">
                Send test booking
              </button>
            </form>
          )}
        </section>
      )}

      {/* Inbound webhook simulator (external partners + editors only) */}
      {canEdit && <InboundWebhookSimulator partner={partner} />}

      {/* Recent transits */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold">Recent transits</h2>
          <Link href="/bookings" className="text-xs text-ink-muted hover:text-ink">View all →</Link>
        </div>
        {recent.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">No transits yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">When</th>
                <th className="text-left px-5 py-3 font-semibold">Role</th>
                <th className="text-left px-5 py-3 font-semibold">Ext. ID</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {recent.map((t) => (
                <tr key={t.id} className="hover:bg-surface-muted">
                  <td className="px-5 py-3 whitespace-nowrap">
                    <div>{new Date(t.createdAt).toLocaleString()}</div>
                  </td>
                  <td className="px-5 py-3 text-ink-muted text-xs">
                    {t.originatorPartnerId === partner.id ? "originator" : "recipient"}
                  </td>
                  <td className="px-5 py-3">
                    <Link href={`/transits/${t.id}`} className="hover:underline">
                      <code className="text-xs">{t.originatorBookingExternalId}</code>
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <TransitStatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] text-sm py-1 items-center">
      <span className="text-ink-muted">{k}</span>
      <span>{typeof v === "string" ? <code className="text-xs">{v}</code> : v}</span>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-semibold text-ink">{label}</span>
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
      {children}
    </label>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active" ? "badge-success" :
    status === "warning" ? "badge-warning" :
    status === "suspended" ? "badge-danger" :
    "badge-neutral";
  return <span className={cls}>{status.replace("_", " ")}</span>;
}

function TransitStatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "badge-success"
      : status === "cancelled" || status === "failed" || status === "no_match" || status.startsWith("error_")
      ? "badge-danger"
      : status === "paused"
      ? "badge-warning"
      : ["pushed", "accepted", "driver_assigned", "en_route", "on_board"].includes(status)
      ? "badge-info"
      : "badge-neutral";
  return <span className={cls}>{status.replace(/_/g, " ")}</span>;
}

// ---------------------------------------------------------------------------
// Health metrics
// ---------------------------------------------------------------------------

const IN_FLIGHT_STATUSES = ["pushed", "accepted", "driver_assigned", "en_route", "on_board"] as const;
const FAILED_STATUSES = ["failed", "no_match", "cancelled"] as const;

type PartnerMetrics = {
  inFlight: number;
  completed24h: number;
  total24h: number;
  successRate: number | null;
  lastActivityAt: Date | null;
  lastActivityAgo: string | null;
};

async function computePartnerMetrics(partnerId: string): Promise<PartnerMetrics> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const involvedExpr = or(
    eq(transits.originatorPartnerId, partnerId),
    eq(transits.recipientPartnerId, partnerId),
  );

  // Count by status in last 24h — one round-trip via GROUP BY
  const statusBuckets = await db
    .select({ status: transits.status, n: count() })
    .from(transits)
    .where(and(involvedExpr, gte(transits.createdAt, since)))
    .groupBy(transits.status);

  let completed24h = 0;
  let failed24h = 0;
  let total24h = 0;
  for (const row of statusBuckets) {
    const n = Number(row.n);
    total24h += n;
    if (row.status === "completed") completed24h += n;
    else if ((FAILED_STATUSES as readonly string[]).includes(row.status)) failed24h += n;
  }
  // Success rate counts only resolved transits (completed + failed bucket).
  // In-flight transits are excluded so the rate doesn't dip artificially
  // while traffic is mid-flight.
  const resolved = completed24h + failed24h;
  const successRate = resolved === 0 ? null : Math.round((completed24h / resolved) * 100);

  // In-flight count — all time, not just 24h, so old stuck transits are visible
  const [{ n: inFlightN } = { n: 0 }] = await db
    .select({ n: count() })
    .from(transits)
    .where(and(involvedExpr, inArray(transits.status, IN_FLIGHT_STATUSES as unknown as string[])));
  const inFlight = Number(inFlightN);

  // Last activity = max(updated_at) on any transit involving this partner
  const [lastRow] = await db
    .select({ updatedAt: sql<Date>`max(${transits.updatedAt})` })
    .from(transits)
    .where(involvedExpr);
  const lastActivityAt = lastRow?.updatedAt ? new Date(lastRow.updatedAt) : null;
  const lastActivityAgo = lastActivityAt ? relativeTimeAgo(lastActivityAt) : null;

  return { inFlight, completed24h, total24h, successRate, lastActivityAt, lastActivityAgo };
}

function relativeTimeAgo(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function MetricCard({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: number | string;
  subtitle?: string;
  tone?: "success" | "danger" | "neutral";
}) {
  const accent =
    tone === "success" ? "bg-success/30" :
    tone === "danger" ? "bg-danger/30" :
    "";
  return (
    <div className={`stat ${accent}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{typeof value === "number" ? value.toLocaleString() : value}</div>
      {subtitle && <div className="text-xs text-ink-muted mt-1">{subtitle}</div>}
    </div>
  );
}

