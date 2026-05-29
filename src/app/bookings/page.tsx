import { db } from "@/db/client";
import { transits, partners } from "@/db/schema";
import { and, desc, eq, inArray, or } from "drizzle-orm";
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

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string; outcome?: string; status?: string; group?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const isSuper = user.role === "super_admin";

  // Filter: single status takes precedence, otherwise group
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

  const recipientIds = Array.from(
    new Set(rows.map((r) => r.t.recipientPartnerId).filter((id): id is string => !!id)),
  );
  const recipients = recipientIds.length
    ? await db.select().from(partners).where(inArray(partners.id, recipientIds))
    : [];
  const recipientById = new Map(recipients.map((r) => [r.id, r]));

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
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">When</th>
                <th className="text-left px-5 py-3 font-semibold">Originator</th>
                <th className="text-left px-5 py-3 font-semibold">Sent to fleet</th>
                <th className="text-left px-5 py-3 font-semibold">External ID</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-5 py-3 font-semibold">Fee snapshot</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ t, originator }) => {
                const fs = t.feeSnapshot;
                const isHighlighted = t.id === highlight;
                const recipient = t.recipientPartnerId ? recipientById.get(t.recipientPartnerId) : null;
                return (
                  <tr
                    key={t.id}
                    className={isHighlighted ? "bg-warning/50" : "hover:bg-surface-muted"}
                  >
                    <td className="px-5 py-3 whitespace-nowrap">
                      <div>{new Date(t.createdAt).toLocaleString()}</div>
                      <div className="text-xs text-ink-subtle">{relativeTime(t.createdAt)}</div>
                    </td>
                    <td className="px-5 py-3 text-ink-muted">
                      {originator?.id ? (
                        <Link href={`/partners/${originator.id}`} className="hover:underline">
                          {originator.name}
                        </Link>
                      ) : (
                        <code className="text-xs">{t.originatorPartnerId.slice(0, 8)}…</code>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-muted">
                      {recipient?.id ? (
                        <Link href={`/partners/${recipient.id}`} className="hover:underline">
                          {recipient.name}
                        </Link>
                      ) : (
                        <span className="text-xs text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Link href={`/transits/${t.id}`} className="hover:underline">
                        <code className="text-xs">{t.originatorBookingExternalId}</code>
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-muted">
                      {fs
                        ? `send ${fs.sendFeePence}p · recv ${fs.receiveFeePence}p · trip +${fs.computedPassengerAddOnsPence}p`
                        : "—"}
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
