import { db } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import { and, count, desc, eq, like, type SQL } from "drizzle-orm";
import { requireSuperAdmin } from "@/lib/auth";
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";

export const dynamic = "force-dynamic";

/**
 * /webhooks — inbound webhook delivery log inspector.
 *
 * Two-column filter: source (which partner / which path) + outcome (what we
 * did with it). Every row's outcome is set by the route handler after
 * processing, so this is the source of truth for "did that webhook land?"
 * debugging when iCabbi traffic starts arriving.
 */

const PAGE_SIZE = 100;

const OUTCOMES = [
  "applied",
  "routed",
  "orphan",
  "ack_unhandled",
  "signature_invalid",
  "error",
  "delivered",        // outbound success
  "delivery_failed",  // outbound failure
] as const;

type Outcome = (typeof OUTCOMES)[number];

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; outcome?: string }>;
}) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const sourceFilter = sp.source ?? null;
  const outcomeFilter = (OUTCOMES as readonly string[]).includes(sp.outcome ?? "")
    ? (sp.outcome as Outcome)
    : null;

  const conditions: SQL[] = [];
  if (sourceFilter) conditions.push(like(webhookDeliveries.source, `${sourceFilter}%`));
  if (outcomeFilter) conditions.push(eq(webhookDeliveries.outcome, outcomeFilter));

  const whereClause = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

  const rows = whereClause
    ? await db
        .select()
        .from(webhookDeliveries)
        .where(whereClause)
        .orderBy(desc(webhookDeliveries.receivedAt))
        .limit(PAGE_SIZE)
    : await db
        .select()
        .from(webhookDeliveries)
        .orderBy(desc(webhookDeliveries.receivedAt))
        .limit(PAGE_SIZE);

  const allSourcesResult = await db
    .selectDistinctOn([webhookDeliveries.source], { source: webhookDeliveries.source })
    .from(webhookDeliveries);
  const sources = allSourcesResult.map((r) => r.source).sort();

  // Quick stats — outcome breakdown across all unfiltered rows.
  //
  // P1-E5: was loading every webhook_deliveries row into memory and reducing
  // in JS. At pilot scale that's a page-render hazard. Now: a single GROUP BY
  // aggregate that returns one row per distinct outcome (≤9 rows).
  const outcomeRows = await db
    .select({ outcome: webhookDeliveries.outcome, n: count() })
    .from(webhookDeliveries)
    .groupBy(webhookDeliveries.outcome);

  const outcomeCounts = new Map<string, number>();
  let pendingCount = 0;
  let totalDeliveries = 0;
  for (const r of outcomeRows) {
    const n = Number(r.n);
    totalDeliveries += n;
    if (r.outcome) outcomeCounts.set(r.outcome, n);
    else pendingCount += n;
  }

  return (
    <div className="space-y-6">
      <LiveRefresh interval={10000} />
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          Inbound webhook log
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Webhook deliveries</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Every inbound webhook hitting <code>/api/webhooks/ingest/*</code> is recorded here at
          receipt time and updated with its processing outcome. Last {PAGE_SIZE} entries shown.
        </p>
      </div>

      {/* Stats strip */}
      {totalDeliveries > 0 && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          {pendingCount > 0 && <StatPill label="pending" count={pendingCount} tone="neutral" />}
          {OUTCOMES.filter((o) => (outcomeCounts.get(o) ?? 0) > 0).map((o) => (
            <StatPill
              key={o}
              label={o.replace("_", " ")}
              count={outcomeCounts.get(o) ?? 0}
              tone={outcomeTone(o)}
            />
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="space-y-2">
        {sources.length > 0 && (
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-xs uppercase tracking-wide text-ink-muted font-semibold w-16">Source</span>
            <Chip href={buildHref(null, outcomeFilter)} label="all" active={!sourceFilter} />
            {sources.map((s) => (
              <Chip key={s} href={buildHref(s, outcomeFilter)} label={s} active={sourceFilter === s} />
            ))}
          </div>
        )}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs uppercase tracking-wide text-ink-muted font-semibold w-16">Outcome</span>
          <Chip href={buildHref(sourceFilter, null)} label="all" active={!outcomeFilter} />
          {OUTCOMES.map((o) => (
            <Chip
              key={o}
              href={buildHref(sourceFilter, o)}
              label={o.replace("_", " ")}
              active={outcomeFilter === o}
            />
          ))}
        </div>
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-ink-muted">
            No webhook deliveries match these filters yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">When</th>
                <th className="text-left px-5 py-3 font-semibold w-[60px]">Dir</th>
                <th className="text-left px-5 py-3 font-semibold">Source</th>
                <th className="text-left px-5 py-3 font-semibold">Event ID</th>
                <th className="text-left px-5 py-3 font-semibold">Event type</th>
                <th className="text-left px-5 py-3 font-semibold">Outcome</th>
                <th className="text-left px-5 py-3 font-semibold">Preview</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const payload = r.payload as Record<string, unknown>;
                const isOutbound = r.source.startsWith("outbound:");
                // For outbound deliveries the envelope is nested under
                // payload.envelope; the inbound shape has it at root.
                const envelope = (isOutbound
                  ? (payload.envelope as Record<string, unknown>)
                  : payload) ?? payload;
                const eventType = String(
                  envelope.event_type ??
                    envelope.type ??
                    payload.event_type ??
                    payload.type ??
                    "—",
                );
                const preview = previewPayload(payload);
                return (
                  <tr key={r.id} className="align-top">
                    <td className="px-5 py-3 whitespace-nowrap">
                      <div>{new Date(r.receivedAt).toLocaleString()}</div>
                      <div className="text-xs text-ink-subtle">{relativeTime(r.receivedAt)}</div>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded ${
                          isOutbound
                            ? "bg-warning/40 text-warning-fg"
                            : "bg-info/40 text-info-fg"
                        }`}
                        title={isOutbound ? "We sent this to a partner" : "Partner sent this to us"}
                      >
                        {isOutbound ? "↑ out" : "↓ in"}
                      </span>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <code className="text-xs">{r.source}</code>
                    </td>
                    <td className="px-5 py-3">
                      <code className="text-xs">{r.sourceEventId.slice(0, 24)}…</code>
                    </td>
                    <td className="px-5 py-3">
                      <span className="badge-info">{eventType}</span>
                    </td>
                    <td className="px-5 py-3">
                      <OutcomeBadge outcome={r.outcome} />
                      {/* Tier-1 #2: surface retry state for failed outbound */}
                      {r.attempts > 1 && (
                        <div className="text-[10px] text-ink-muted mt-1">
                          {r.flaggedAt
                            ? `⚠️ flagged · ${r.attempts} attempts`
                            : r.outcome === "delivered"
                            ? `recovered on attempt ${r.attempts}`
                            : `${r.attempts} attempts so far`}
                        </div>
                      )}
                      {r.nextAttemptAt && r.outcome === "delivery_failed" && (
                        <div className="text-[10px] text-warning-fg mt-1">
                          ↻ retry in {relativeFuture(r.nextAttemptAt)}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 max-w-md">
                      <code className="text-xs text-ink-muted whitespace-pre-wrap break-words block">
                        {preview}
                      </code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-ink-muted">
        For deeper inspection, query <code>webhook_deliveries</code> directly with{" "}
        <code>pnpm db:studio</code>. This table is the source of truth for idempotency —
        deleting a row will let that envelope id be replayed.
      </p>
    </div>
  );
}

function relativeFuture(d: Date | string): string {
  const sec = Math.max(0, Math.floor((new Date(d).getTime() - Date.now()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

function buildHref(source: string | null, outcome: string | null): string {
  const qs = new URLSearchParams();
  if (source) qs.set("source", source);
  if (outcome) qs.set("outcome", outcome);
  const str = qs.toString();
  return str ? `/webhooks?${str}` : "/webhooks";
}

function StatPill({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <div className={`stat ${tone === "success" ? "bg-success/40" : tone === "danger" ? "bg-danger/40" : tone === "warning" ? "bg-warning/40" : tone === "info" ? "bg-info/40" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value text-xl">{count.toLocaleString()}</div>
    </div>
  );
}

function outcomeTone(o: Outcome): string {
  if (o === "applied" || o === "routed") return "success";
  if (o === "orphan" || o === "ack_unhandled") return "warning";
  if (o === "signature_invalid" || o === "error") return "danger";
  return "neutral";
}

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="badge-neutral">pending</span>;
  const cls =
    outcome === "applied" || outcome === "routed" ? "badge-success" :
    outcome === "orphan" || outcome === "ack_unhandled" ? "badge-warning" :
    outcome === "signature_invalid" || outcome === "error" ? "badge-danger" :
    "badge-neutral";
  return <span className={cls}>{outcome.replace("_", " ")}</span>;
}

function previewPayload(payload: Record<string, unknown>): string {
  try {
    const data = payload.data;
    if (typeof data === "string" && data.startsWith("{")) {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      return JSON.stringify(parsed, null, 0).slice(0, 200);
    }
  } catch {
    // fall through
  }
  return JSON.stringify(payload, null, 0).slice(0, 200);
}

function Chip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 rounded-full text-xs font-semibold border border-border-strong ${
        active ? "bg-ink text-white" : "bg-white text-ink hover:bg-surface-muted"
      }`}
    >
      {label}
    </Link>
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
