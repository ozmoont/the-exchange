import { db } from "@/db/client";
import { transits, partners, transitEvents } from "@/db/schema";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import {
  STATUSES_BY_GROUP,
  GROUP_LABEL,
  statusBadgeClass,
  statusLabel,
  statusMeta,
  type StatusGroup,
} from "@/lib/status-labels";

export const dynamic = "force-dynamic";

const GROUPS: StatusGroup[] = ["in_flight", "completed", "no_match", "error", "paused", "cancelled"];
const TERMINAL = new Set(["completed", "cancelled", "failed", "no_match", "error_auth", "error_other"]);

type BookingPayload = {
  bookingType?: "asap" | "prebook";
  scheduledFor?: string;
  pickup?: { lat?: number; lng?: number; address?: string };
  dropoff?: { lat?: number; lng?: number; address?: string };
  passenger?: { name?: string; phone?: string };
};

type DriverDetail = {
  driver?: {
    first_name?: string;
    last_name?: string;
    phone_number?: string;
    license_number?: string;
  };
  description?: string;
  vehicle_class?: string;
};

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string; outcome?: string; status?: string; group?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const isSuper = user.role === "super_admin";

  const filterStatus = sp.status?.trim();
  const filterGroup = sp.group?.trim() as StatusGroup | undefined;
  const filterStatuses =
    filterStatus
      ? [filterStatus]
      : filterGroup && STATUSES_BY_GROUP[filterGroup]
      ? STATUSES_BY_GROUP[filterGroup]
      : null;

  const scopedWhere = isSuper
    ? undefined
    : user.partnerId
    ? or(
        eq(transits.originatorPartnerId, user.partnerId),
        eq(transits.recipientPartnerId, user.partnerId),
      )
    : eq(transits.id, "00000000-0000-0000-0000-000000000000");

  const statusWhere = filterStatuses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? inArray(transits.status as any, filterStatuses)
    : undefined;

  const whereClause =
    scopedWhere && statusWhere ? and(scopedWhere, statusWhere) : scopedWhere ?? statusWhere;

  const rows = await db
    .select({ t: transits, originator: partners })
    .from(transits)
    .leftJoin(partners, eq(transits.originatorPartnerId, partners.id))
    .where(whereClause)
    .orderBy(desc(transits.createdAt))
    .limit(200);

  const transitIds = rows.map((r) => r.t.id);
  const recipientIds = Array.from(
    new Set(rows.map((r) => r.t.recipientPartnerId).filter((id): id is string => !!id)),
  );

  // Recipient names
  const recipients = recipientIds.length
    ? await db.select().from(partners).where(inArray(partners.id, recipientIds))
    : [];
  const recipientById = new Map(recipients.map((r) => [r.id, r]));

  // Pull every driver-bearing event for the displayed transits, then take the
  // most recent per transit in JS. Slightly more rows over the wire than a
  // DISTINCT ON, but it goes through drizzle's parameter binding instead of
  // raw SQL with array-cast syntax that bit us on prod. At 200 transits this
  // is ~50ms worst case.
  const driverByTransit = new Map<string, DriverDetail>();
  if (transitIds.length > 0) {
    const driverEvents = await db
      .select({
        transitId: transitEvents.transitId,
        detail: transitEvents.detail,
        createdAt: transitEvents.createdAt,
      })
      .from(transitEvents)
      .where(
        and(
          inArray(transitEvents.transitId, transitIds),
          // detail->'driver' IS NOT NULL — equivalent of `detail ? 'driver'`
          sql`${transitEvents.detail} -> 'driver' IS NOT NULL`,
        ),
      )
      .orderBy(desc(transitEvents.createdAt));

    for (const evt of driverEvents) {
      // First row per transit wins (we sorted desc, so it's the most recent)
      if (!driverByTransit.has(evt.transitId) && evt.detail) {
        driverByTransit.set(evt.transitId, evt.detail as DriverDetail);
      }
    }
  }

  const highlight = sp.highlight ?? null;
  const outcome = sp.outcome ?? null;

  const filterLabel = filterStatus
    ? statusLabel(filterStatus)
    : filterGroup
    ? GROUP_LABEL[filterGroup]
    : null;

  return (
    <div className="space-y-6">
      <LiveRefresh interval={10000} />
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          {isSuper ? "Network activity" : "Your bookings"}
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Bookings</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Every booking that has moved (or tried to move) through the network. Each row is keyed
          by (originator, originator&apos;s booking id) — duplicate webhook deliveries collapse here.
        </p>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Link
          href="/bookings"
          className={`px-3 py-1.5 rounded-full border ${
            !filterStatus && !filterGroup
              ? "bg-ink text-surface border-ink"
              : "border-border hover:bg-surface-muted"
          }`}
        >
          All
        </Link>
        {GROUPS.map((g) => (
          <Link
            key={g}
            href={`/bookings?group=${g}`}
            className={`px-3 py-1.5 rounded-full border ${
              filterGroup === g
                ? "bg-ink text-surface border-ink"
                : "border-border hover:bg-surface-muted"
            }`}
          >
            {GROUP_LABEL[g]}
          </Link>
        ))}
        {filterStatus && (
          <span className="px-3 py-1.5 rounded-full bg-ink text-surface border border-ink">
            {filterLabel}
          </span>
        )}
      </div>

      {outcome && (
        <div
          className={`p-3 rounded-md text-sm ${
            outcome === "pushed"
              ? "bg-success text-success-fg"
              : outcome === "no_match"
              ? "bg-warning text-warning-fg"
              : outcome === "paused"
              ? "bg-info text-info-fg"
              : "bg-danger text-danger-fg"
          }`}
        >
          Test booking outcome: <strong>{statusLabel(outcome)}</strong>
          {highlight && (
            <span className="opacity-70 ml-2">
              · booking <code className="text-xs">{highlight.slice(0, 8)}…</code> highlighted below
            </span>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-ink-muted">
            {filterLabel
              ? <>No bookings with status <strong>{filterLabel}</strong> right now.</>
              : "No bookings yet — try sending a test booking from a partner detail page."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle bg-surface-muted/40">
              <tr>
                <th className="text-left px-4 py-3 font-semibold w-[140px]">Booked</th>
                <th className="text-left px-4 py-3 font-semibold w-[160px]">Pickup time</th>
                <th className="text-left px-4 py-3 font-semibold">Route</th>
                <th className="text-left px-4 py-3 font-semibold">Fleet & driver</th>
                <th className="text-left px-4 py-3 font-semibold w-[140px]">Status</th>
                <th className="text-right px-4 py-3 font-semibold w-[80px]">Fee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ t, originator }) => {
                const isHighlighted = t.id === highlight;
                const recipient = t.recipientPartnerId ? recipientById.get(t.recipientPartnerId) : null;
                const bp = (t.bookingPayload ?? {}) as BookingPayload;
                const driver = driverByTransit.get(t.id);

                const isPrebook = bp.bookingType === "prebook" && bp.scheduledFor;
                const pickupTime = isPrebook ? new Date(bp.scheduledFor as string) : null;

                const isTerminal = TERMINAL.has(t.status);
                const durationMs =
                  isTerminal && t.status === "completed"
                    ? new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime()
                    : null;

                const driverName = driver?.driver
                  ? [driver.driver.first_name, driver.driver.last_name].filter(Boolean).join(" ")
                  : null;
                const driverPhone = driver?.driver?.phone_number ?? null;

                return (
                  <tr
                    key={t.id}
                    className={isHighlighted ? "bg-warning/50" : "hover:bg-surface-muted/50"}
                  >
                    {/* Booked at */}
                    <td className="px-4 py-3 whitespace-nowrap align-top">
                      <div className="text-xs font-medium">
                        {new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                      <div className="text-[11px] text-ink-subtle">
                        {new Date(t.createdAt).toLocaleDateString([], { day: "2-digit", month: "short" })}
                      </div>
                      <div className="text-[10px] text-ink-subtle mt-0.5">
                        {relativeTime(t.createdAt)}
                      </div>
                    </td>

                    {/* Pickup time */}
                    <td className="px-4 py-3 whitespace-nowrap align-top">
                      {pickupTime ? (
                        <>
                          <div className="text-xs font-medium">
                            {pickupTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </div>
                          <div className="text-[11px] text-ink-subtle">
                            {pickupTime.toLocaleDateString([], { day: "2-digit", month: "short" })}
                          </div>
                          <span className="inline-block mt-1 text-[10px] uppercase tracking-wide bg-info/30 text-info-fg px-1.5 py-0.5 rounded">
                            Pre-book
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="inline-block text-[10px] uppercase tracking-wide bg-warning/40 text-warning-fg px-1.5 py-0.5 rounded">
                            ASAP
                          </span>
                          {durationMs !== null && (
                            <div className="text-[11px] text-ink-subtle mt-1">
                              {fmtDuration(durationMs)} trip
                            </div>
                          )}
                        </>
                      )}
                    </td>

                    {/* Route */}
                    <td className="px-4 py-3 align-top">
                      <Link href={`/transits/${t.id}`} className="block hover:underline">
                        <div className="text-xs text-ink truncate max-w-[260px]">
                          {bp.pickup?.address ?? "—"}
                        </div>
                        <div className="text-[10px] text-ink-subtle">↓</div>
                        <div className="text-xs text-ink truncate max-w-[260px]">
                          {bp.dropoff?.address ?? "—"}
                        </div>
                        <div className="mt-1">
                          <code className="text-[10px] text-ink-subtle">{t.originatorBookingExternalId}</code>
                        </div>
                      </Link>
                    </td>

                    {/* Fleet & driver */}
                    <td className="px-4 py-3 align-top text-xs">
                      <div className="text-ink-muted text-[10px] uppercase tracking-wide font-semibold">
                        Sent from
                      </div>
                      <div className="text-ink truncate max-w-[180px]">
                        {originator?.id ? (
                          <Link href={`/partners/${originator.id}`} className="hover:underline">
                            {originator.name}
                          </Link>
                        ) : (
                          <code className="text-[10px]">{t.originatorPartnerId.slice(0, 8)}…</code>
                        )}
                      </div>
                      <div className="text-ink-muted text-[10px] uppercase tracking-wide font-semibold mt-2">
                        Sent to
                      </div>
                      <div className="text-ink truncate max-w-[180px]">
                        {recipient?.id ? (
                          <Link href={`/partners/${recipient.id}`} className="hover:underline">
                            {recipient.name}
                          </Link>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </div>
                      {driverName && (
                        <div className="mt-2 pt-2 border-t border-border">
                          <div className="text-ink-muted text-[10px] uppercase tracking-wide font-semibold">
                            Driver
                          </div>
                          <div className="text-ink truncate max-w-[180px]">{driverName}</div>
                          {driverPhone && (
                            <a
                              href={`tel:${driverPhone.replace(/\s+/g, "")}`}
                              className="text-[11px] text-ink-muted hover:text-ink hover:underline"
                            >
                              {driverPhone}
                            </a>
                          )}
                          {driver?.description && (
                            <div className="text-[10px] text-ink-subtle truncate max-w-[180px]">
                              {driver.description}
                            </div>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3 align-top">
                      <StatusBadge status={t.status} />
                      {durationMs !== null && (
                        <div className="text-[11px] text-ink-subtle mt-1">
                          {fmtDuration(durationMs)}
                        </div>
                      )}
                    </td>

                    {/* Fee */}
                    <td className="px-4 py-3 text-right align-top tabular-nums">
                      {t.feeSnapshot ? (
                        <div className="text-xs font-medium">
                          {fmtMoney(t.feeSnapshot.receiveFeePence)}
                        </div>
                      ) : (
                        <span className="text-[11px] text-ink-subtle">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span className={statusBadgeClass(status)} title={meta.description}>
      {meta.label}
    </span>
  );
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

function fmtDuration(ms: number) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function fmtMoney(pence: number) {
  return pence >= 1000 ? `£${(pence / 100).toFixed(2)}` : `${pence}p`;
}
