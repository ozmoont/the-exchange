import { db } from "@/db/client";
import { transits, partners } from "@/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string; outcome?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const isSuper = user.role === "super_admin";

  const scopedWhere = isSuper
    ? undefined
    : user.partnerId
    ? or(
        eq(transits.originatorPartnerId, user.partnerId),
        eq(transits.recipientPartnerId, user.partnerId),
      )
    : eq(transits.id, "00000000-0000-0000-0000-000000000000");

  const rows = await db
    .select({ t: transits, originator: partners })
    .from(transits)
    .leftJoin(partners, eq(transits.originatorPartnerId, partners.id))
    .where(scopedWhere)
    .orderBy(desc(transits.createdAt))
    .limit(200);

  const highlight = sp.highlight ?? null;
  const outcome = sp.outcome ?? null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          {isSuper ? "Network activity" : "Your bookings"}
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Transits</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Every booking that has moved (or tried to move) through the network. Each row is one
          transit keyed by (originator, originator&apos;s booking id) — duplicate webhook
          deliveries collapse here.
        </p>
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
          Test booking outcome: <strong>{outcome}</strong>
          {highlight && (
            <span className="opacity-70 ml-2">
              · transit <code className="text-xs">{highlight.slice(0, 8)}…</code> highlighted below
            </span>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-ink-muted">
            No transits yet — try sending a test booking from a partner detail page.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">When</th>
                <th className="text-left px-5 py-3 font-semibold">Originator</th>
                <th className="text-left px-5 py-3 font-semibold">External ID</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-5 py-3 font-semibold">Fee snapshot</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ t, originator }) => {
                const fs = t.feeSnapshot;
                const isHighlighted = t.id === highlight;
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
                      {originator?.name ?? <code className="text-xs">{t.originatorPartnerId.slice(0, 8)}…</code>}
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

function relativeTime(d: Date | string) {
  const sec = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
