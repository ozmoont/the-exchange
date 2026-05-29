import { db } from "@/db/client";
import { transits, partners } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import { requireSuperAdmin } from "@/lib/auth";
import { LiveRefresh } from "@/components/live-refresh";
import { UKCoverageMap } from "@/components/uk-coverage-map";
import {
  statusBadgeClass,
  statusLabel,
} from "@/lib/status-labels";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Distribution view — answers the question "if a job comes in, who gets it?"
 *
 * Super-admin only. Shows:
 *   - UK coverage map: fleets + recent pickup heat
 *   - Top-line clickable stat cards (each drills into /bookings filtered)
 *   - Per-fleet table: wins, completed, success%, avg fee, regions
 *   - Region breakdown
 *   - 14-day volume sparkline
 */
export default async function DistributionPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const windowSize = Math.min(Math.max(Number(sp.window) || 1000, 100), 5000);

  // Recent bookings — ordered, capped
  const rows = await db
    .select()
    .from(transits)
    .orderBy(desc(transits.createdAt))
    .limit(windowSize);

  const allPartners = await db.select().from(partners);
  const partnerById = new Map(allPartners.map((p) => [p.id, p]));

  // Aggregate per-recipient stats
  type Bucket = {
    partnerId: string;
    name: string;
    region: string | null;
    wins: number;
    completed: number;
    cancelled: number;
    inFlight: number;
    failed: number;
    totalReceiveFeePence: number;
  };
  const buckets = new Map<string, Bucket>();
  let totalRouted = 0;
  let totalCompleted = 0;
  let totalInFlight = 0;
  let totalNoMatch = 0;
  let totalPaused = 0;
  let totalErrored = 0;
  let totalCancelled = 0;
  let totalAttempted = 0;

  const regionVolume = new Map<string, number>();
  const pickups: Array<{ lat: number; lng: number; status: string }> = [];

  for (const t of rows) {
    totalAttempted++;
    const inFlightStatuses = new Set([
      "received",
      "routing",
      "pushed",
      "accepted",
      "driver_assigned",
      "en_route",
      "on_board",
    ]);
    if (t.status === "completed") totalCompleted++;
    else if (t.status === "no_match") totalNoMatch++;
    else if (t.status === "paused") totalPaused++;
    else if (t.status === "cancelled") totalCancelled++;
    else if (t.status.startsWith("error_") || t.status === "failed") totalErrored++;
    else if (inFlightStatuses.has(t.status)) totalInFlight++;

    // Pickup coordinates for heat dots — pull from booking payload
    const bp = t.bookingPayload as { pickup?: { lat?: number; lng?: number } } | null;
    if (bp?.pickup?.lat != null && bp?.pickup?.lng != null) {
      pickups.push({ lat: bp.pickup.lat, lng: bp.pickup.lng, status: t.status });
    }

    if (!t.recipientPartnerId) continue;
    totalRouted++;
    const p = partnerById.get(t.recipientPartnerId);
    const region = p?.operatingRegions?.[0] ?? null;
    if (region) regionVolume.set(region, (regionVolume.get(region) ?? 0) + 1);

    let b = buckets.get(t.recipientPartnerId);
    if (!b) {
      b = {
        partnerId: t.recipientPartnerId,
        name: p?.name ?? t.recipientPartnerId.slice(0, 8),
        region,
        wins: 0,
        completed: 0,
        cancelled: 0,
        inFlight: 0,
        failed: 0,
        totalReceiveFeePence: 0,
      };
      buckets.set(t.recipientPartnerId, b);
    }
    b.wins++;
    const fee = t.feeSnapshot?.receiveFeePence ?? 0;
    b.totalReceiveFeePence += fee;

    if (t.status === "completed") b.completed++;
    else if (t.status === "cancelled" || t.status === "failed" || t.status.startsWith("error_")) b.cancelled++;
    else if (inFlightStatuses.has(t.status)) b.inFlight++;
    else if (t.status === "no_match") b.failed++;
  }

  const ranked = [...buckets.values()].sort((a, b) => b.wins - a.wins);
  const maxWins = ranked[0]?.wins ?? 1;

  // Concentration: top 10% of winning fleets' share of routed bookings
  const sortedWins = ranked.map((b) => b.wins).sort((a, b) => b - a);
  const topPctCount = Math.max(1, Math.ceil(sortedWins.length * 0.1));
  const topPctShare =
    totalRouted > 0
      ? sortedWins.slice(0, topPctCount).reduce((s, n) => s + n, 0) / totalRouted
      : 0;

  // Fleets to render on the map — every active partner with a centroid
  const mapFleets = allPartners
    .filter((p) => p.centroidLat != null && p.centroidLng != null && p.status === "active")
    .map((p) => ({
      id: p.id,
      name: p.name,
      lat: p.centroidLat as number,
      lng: p.centroidLng as number,
      wins: buckets.get(p.id)?.wins ?? 0,
    }));

  // Per-day volume sparkline (last 14 days)
  const dailyRows = await db
    .select({
      day: sql<string>`date_trunc('day', ${transits.createdAt})::date::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(transits)
    .where(sql`${transits.createdAt} > now() - interval '14 days'`)
    .groupBy(sql`date_trunc('day', ${transits.createdAt})`)
    .orderBy(sql`date_trunc('day', ${transits.createdAt})`);

  const maxDaily = Math.max(1, ...dailyRows.map((d) => d.count));

  const fmtMoney = (p: number) =>
    p >= 1000 ? `£${(p / 100).toFixed(2)}` : `${p}p`;

  return (
    <div className="space-y-6">
      <LiveRefresh interval={15000} />

      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            Live network
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">Distribution</h1>
          <p className="text-sm text-ink-muted mt-2 max-w-2xl">
            Who&apos;s getting the jobs. Last <strong>{totalAttempted}</strong>{" "}
            routing attempts across <strong>{buckets.size}</strong> winning fleets.
            Click any stat card to drill into the matching bookings.
          </p>
        </div>
        <div className="text-xs">
          <Link
            href="/distribution?window=200"
            className={`px-2 py-1 rounded mr-1 ${windowSize === 200 ? "bg-ink text-surface" : "hover:bg-surface-muted"}`}
          >
            200
          </Link>
          <Link
            href="/distribution?window=1000"
            className={`px-2 py-1 rounded mr-1 ${windowSize === 1000 ? "bg-ink text-surface" : "hover:bg-surface-muted"}`}
          >
            1k
          </Link>
          <Link
            href="/distribution?window=5000"
            className={`px-2 py-1 rounded ${windowSize === 5000 ? "bg-ink text-surface" : "hover:bg-surface-muted"}`}
          >
            5k
          </Link>
        </div>
      </div>

      {/* Clickable top-line metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatLink
          label="Routed"
          value={String(totalRouted)}
          sub="sent to a fleet"
          href="/bookings"
          tone="info"
        />
        <StatLink
          label="Completed"
          value={String(totalCompleted)}
          sub="trips delivered"
          href="/bookings?group=completed"
          tone="success"
        />
        <StatLink
          label="In flight"
          value={String(totalInFlight)}
          sub="awaiting pickup / on board"
          href="/bookings?group=in_flight"
          tone="info"
        />
        <StatLink
          label="No match"
          value={String(totalNoMatch)}
          sub="no eligible fleet"
          href="/bookings?group=no_match"
          tone="danger"
        />
        <StatLink
          label="Errors"
          value={String(totalErrored)}
          sub="adapter / auth failures"
          href="/bookings?group=error"
          tone="danger"
        />
        <StatLink
          label="Paused / cancelled"
          value={String(totalPaused + totalCancelled)}
          sub={`${totalPaused} paused · ${totalCancelled} cancelled`}
          href="/bookings?group=cancelled"
          tone="warning"
        />
      </div>

      {/* UK coverage map */}
      <UKCoverageMap fleets={mapFleets} pickups={pickups.slice(0, 500)} />

      {/* Concentration + sparkline row */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold">
            Concentration
          </p>
          <p className="text-3xl font-bold tracking-tight mt-1 tabular-nums">
            {ranked.length ? `${(topPctShare * 100).toFixed(0)}%` : "—"}
          </p>
          <p className="text-sm text-ink-muted mt-1">
            of routed jobs went to the top 10% ({topPctCount} of {ranked.length}) winning fleets
          </p>
          <p className="text-xs text-ink-subtle mt-3">
            Unique winners: <strong>{buckets.size}</strong> of {allPartners.filter((p) => p.status === "active").length} active partners
          </p>
        </div>

        {dailyRows.length > 0 && (
          <div className="card p-5">
            <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold mb-3">
              Last 14 days · bookings per day
            </p>
            <div className="flex items-end gap-1 h-24">
              {dailyRows.map((d) => (
                <div
                  key={d.day}
                  className="flex-1 bg-info hover:bg-info/80 transition-colors rounded-t"
                  style={{ height: `${(d.count / maxDaily) * 100}%` }}
                  title={`${d.day}: ${d.count}`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-ink-subtle mt-1">
              <span>{dailyRows[0]?.day}</span>
              <span>{dailyRows[dailyRows.length - 1]?.day}</span>
            </div>
          </div>
        )}
      </div>

      {/* Region breakdown */}
      {regionVolume.size > 0 && (
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold mb-3">
            Volume by region (winning fleet&apos;s operating region)
          </p>
          <div className="space-y-2">
            {[...regionVolume.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([region, count]) => (
                <div key={region} className="flex items-center gap-3 text-sm">
                  <div className="w-40 text-ink-muted truncate">{region}</div>
                  <div className="flex-1 bg-surface-muted rounded h-5 relative overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 bg-info"
                      style={{ width: `${(count / Math.max(...regionVolume.values())) * 100}%` }}
                    />
                  </div>
                  <div className="w-12 text-right tabular-nums">{count}</div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Winning fleets table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h2 className="font-semibold">Winning fleets</h2>
          <span className="text-xs text-ink-subtle">{ranked.length} fleets won jobs in the window</span>
        </div>
        {ranked.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-ink-muted">
            No jobs routed yet. Run <code className="text-xs bg-surface-muted px-1.5 py-0.5 rounded">pnpm fire-jobs --count 500</code> to populate.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">#</th>
                <th className="text-left px-5 py-3 font-semibold">Fleet</th>
                <th className="text-left px-5 py-3 font-semibold">Region</th>
                <th className="text-right px-5 py-3 font-semibold">Wins</th>
                <th className="text-left px-5 py-3 font-semibold">Share</th>
                <th className="text-right px-5 py-3 font-semibold">Complete</th>
                <th className="text-right px-5 py-3 font-semibold">In-flight</th>
                <th className="text-right px-5 py-3 font-semibold">Failed</th>
                <th className="text-right px-5 py-3 font-semibold">Avg fee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ranked.slice(0, 50).map((b, i) => {
                const sharePct = (b.wins / totalRouted) * 100;
                const avgFee = b.wins ? b.totalReceiveFeePence / b.wins : 0;
                return (
                  <tr key={b.partnerId} className="hover:bg-surface-muted">
                    <td className="px-5 py-3 text-xs text-ink-subtle tabular-nums">{i + 1}</td>
                    <td className="px-5 py-3">
                      <Link href={`/partners/${b.partnerId}`} className="hover:underline font-medium">
                        {b.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-ink-muted text-xs">{b.region ?? "—"}</td>
                    <td className="px-5 py-3 text-right tabular-nums font-medium">{b.wins}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-surface-muted rounded h-2 relative overflow-hidden min-w-[60px]">
                          <div
                            className="absolute inset-y-0 left-0 bg-info"
                            style={{ width: `${(b.wins / maxWins) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-ink-subtle tabular-nums w-12">
                          {sharePct.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-success-fg">{b.completed}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-info-fg">{b.inFlight}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-subtle">{b.cancelled}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-muted">{fmtMoney(Math.round(avgFee))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {ranked.length > 50 && (
          <div className="px-5 py-3 text-xs text-ink-subtle border-t border-border">
            Showing top 50 of {ranked.length} winning fleets.
          </div>
        )}
      </div>

      {/* CLI hint */}
      <div className="card p-5 bg-surface-muted/30">
        <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold mb-2">
          Populate the network
        </p>
        <pre className="text-xs bg-ink text-surface rounded p-3 overflow-x-auto">
{`# Spawn 100 demo fleets across the UK
pnpm spawn-fleets --count 100

# Push 500 bookings through the routing engine
pnpm fire-jobs --count 500`}
        </pre>
      </div>

      {/* Suppressed helpers (kept to avoid unused-import churn) */}
      <span className="hidden">
        <span className={statusBadgeClass("pushed")}>{statusLabel("pushed")}</span>
      </span>
    </div>
  );
}

function StatLink({
  label,
  value,
  sub,
  href,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  href: string;
  tone: "info" | "success" | "danger" | "warning";
}) {
  const accent =
    tone === "success"
      ? "border-l-green-500"
      : tone === "danger"
      ? "border-l-red-500"
      : tone === "warning"
      ? "border-l-amber-500"
      : "border-l-sky-500";
  return (
    <Link
      href={href}
      className={`card p-4 border-l-4 ${accent} hover:bg-surface-muted/40 transition-colors`}
    >
      <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold">{label}</p>
      <p className="text-2xl font-bold tracking-tight mt-1 tabular-nums">{value}</p>
      <p className="text-xs text-ink-muted mt-1">{sub}</p>
    </Link>
  );
}
