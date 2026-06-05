/**
 * P1-O1 — Public status page.
 *
 * Lives at /status, publicly readable, no PII. Designed to be shown to a
 * pilot fleet to answer "is The Exchange up right now?" without us having to
 * give them a login.
 *
 * Sources of truth:
 *   - networkControls: last cron run timestamps (queue drain, reliability,
 *     reconciliation) — every cron tick UPDATEs the corresponding column.
 *   - synthetic_test_runs: hourly synthetic booking outcomes — last 24h
 *     rolling window tells us if routing has been working.
 *   - transits aggregates: routed/in-flight/completed counts as activity
 *     proof. Counts only — no booking ids, addresses, or partner names.
 *   - DB connectivity is implicit: the page renders by querying the DB.
 *
 * Refreshes every 30 seconds via LiveRefresh.
 */

import { db } from "@/db/client";
import {
  networkControls,
  syntheticTestRuns,
  transits,
  partners,
} from "@/db/schema";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { LiveRefresh } from "@/components/live-refresh";
import Link from "next/link";

export const dynamic = "force-dynamic";

// Freshness thresholds — how stale before we flag a subsystem as degraded.
// These mirror the cron cadences in vercel.json with generous slack:
//   process-queue        runs every 1 min  → degraded after 5 min
//   reliability recompute runs every 5 min  → degraded after 15 min
//   reconciliation        runs every 60 min → degraded after 90 min
//   synthetic test        runs every 60 min → degraded after 90 min
const QUEUE_FRESH_MS = 5 * 60_000;
const RELIABILITY_FRESH_MS = 15 * 60_000;
const RECONCILE_FRESH_MS = 90 * 60_000;
const SYNTHETIC_FRESH_MS = 90 * 60_000;

type Health = "operational" | "degraded" | "no_data";

function classify(lastAt: Date | null | undefined, freshMs: number): Health {
  if (!lastAt) return "no_data";
  return Date.now() - new Date(lastAt).getTime() <= freshMs
    ? "operational"
    : "degraded";
}

function relativeTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const sec = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.floor(hr / 24)} d ago`;
}

export default async function StatusPage() {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last1h = new Date(now.getTime() - 60 * 60 * 1000);

  // ---------------------------------------------------------------
  // System health — cron freshness
  // ---------------------------------------------------------------
  const [control] = await db
    .select()
    .from(networkControls)
    .where(eq(networkControls.id, "global"));

  const killOn = control?.killSwitch ?? false;

  // ---------------------------------------------------------------
  // Synthetic monitor — last 24h
  // ---------------------------------------------------------------
  const syntheticRows = await db
    .select()
    .from(syntheticTestRuns)
    .where(gte(syntheticTestRuns.ranAt, last24h))
    .orderBy(desc(syntheticTestRuns.ranAt));

  const totalRuns = syntheticRows.length;
  const passRuns = syntheticRows.filter(
    (r) => r.outcome === "pushed" || r.outcome === "skipped_no_pair",
  ).length;
  const uptimePct = totalRuns > 0 ? Math.round((passRuns / totalRuns) * 100) : null;
  const lastSynthetic = syntheticRows[0] ?? null;
  const lastSyntheticAt = lastSynthetic?.ranAt ?? null;

  // Routing engine health = freshest of (synthetic test last run, queue drain)
  // — if either is fresh and last synthetic was a pass we call it operational.
  const queueHealth = classify(control?.lastDemoTickAt, QUEUE_FRESH_MS);
  const reliabilityHealth = classify(control?.lastReliabilityComputeAt, RELIABILITY_FRESH_MS);
  const reconcileHealth = classify(control?.lastReconciliationRunAt, RECONCILE_FRESH_MS);
  const syntheticHealth: Health = killOn
    ? "no_data" // expected: synthetic skips when kill switch is on
    : !lastSyntheticAt
    ? "no_data"
    : Date.now() - new Date(lastSyntheticAt).getTime() > SYNTHETIC_FRESH_MS
    ? "degraded"
    : (lastSynthetic?.outcome === "pushed" ||
        lastSynthetic?.outcome === "skipped_no_pair")
    ? "operational"
    : "degraded";

  const routingHealth: Health =
    killOn ? "degraded" : syntheticHealth === "no_data" ? queueHealth : syntheticHealth;

  // Overall — green only if everything we care about is operational.
  const overall: Health =
    killOn
      ? "degraded"
      : [routingHealth, queueHealth, reliabilityHealth, reconcileHealth].some(
          (h) => h === "degraded",
        )
      ? "degraded"
      : "operational";

  // ---------------------------------------------------------------
  // Activity counts (aggregates only, no PII)
  // ---------------------------------------------------------------
  const inFlightStatuses = [
    "received",
    "routing",
    "pushed",
    "accepted",
    "driver_assigned",
    "driver_arrived",
    "en_route",
    "on_board",
  ] as const;

  const [routedLast1h] = await db
    .select({ n: count() })
    .from(transits)
    .where(
      and(
        gte(transits.createdAt, last1h),
        sql`${transits.originatorBookingExternalId} NOT LIKE 'SYNTH-%'`,
      ),
    );
  const [routedLast24h] = await db
    .select({ n: count() })
    .from(transits)
    .where(
      and(
        gte(transits.createdAt, last24h),
        sql`${transits.originatorBookingExternalId} NOT LIKE 'SYNTH-%'`,
      ),
    );
  const [completedLast24h] = await db
    .select({ n: count() })
    .from(transits)
    .where(
      and(
        gte(transits.createdAt, last24h),
        eq(transits.status, "completed"),
        sql`${transits.originatorBookingExternalId} NOT LIKE 'SYNTH-%'`,
      ),
    );
  const [inFlightNow] = await db
    .select({ n: count() })
    .from(transits)
    .where(
      and(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql`${transits.status} IN ('received', 'routing', 'pushed', 'accepted', 'driver_assigned', 'driver_arrived', 'en_route', 'on_board')`,
        sql`${transits.originatorBookingExternalId} NOT LIKE 'SYNTH-%'`,
      ),
    );
  const [activePartners] = await db
    .select({ n: count() })
    .from(partners)
    .where(eq(partners.status, "active"));
  void inFlightStatuses;

  return (
    <div className="min-h-screen bg-surface-muted">
      <LiveRefresh interval={30000} />
      <header className="border-b border-border bg-white">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-accent" aria-hidden="true" />
            <span className="font-bold tracking-tight">The Exchange</span>
            <span className="text-ink-subtle text-sm">·</span>
            <span className="text-sm text-ink-muted">Status</span>
          </div>
          <Link href="/" className="text-xs text-ink-muted hover:text-ink">
            Back to app →
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        {/* Headline */}
        <section>
          <div className="flex items-center gap-3 mb-2">
            <HealthDot health={overall} size="lg" />
            <h1 className="text-3xl font-bold tracking-tight">
              {overall === "operational"
                ? "All systems operational"
                : killOn
                ? "Network kill switch is engaged"
                : "Some systems are degraded"}
            </h1>
          </div>
          <p className="text-sm text-ink-muted">
            Updated{" "}
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {" · "}auto-refreshes every 30 seconds
          </p>
        </section>

        {/* Components */}
        <section className="card divide-y divide-border">
          <header className="px-5 py-4 border-b border-border">
            <h2 className="font-semibold">Components</h2>
          </header>
          <ComponentRow
            label="Routing engine"
            description="Synthetic test booking pushed successfully in the last 90 minutes."
            health={routingHealth}
            lastAt={lastSyntheticAt}
            lastLabel={lastSynthetic ? `last test: ${lastSynthetic.outcome}` : null}
          />
          <ComponentRow
            label="Queue drain"
            description="Inbound bookings move from received → routing within minutes."
            health={queueHealth}
            lastAt={control?.lastDemoTickAt ?? null}
          />
          <ComponentRow
            label="Reliability scoring"
            description="Partner acceptance rates recomputed every 5 minutes."
            health={reliabilityHealth}
            lastAt={control?.lastReliabilityComputeAt ?? null}
          />
          <ComponentRow
            label="Fee reconciliation"
            description="Completed bookings reconciled against partner billing hourly."
            health={reconcileHealth}
            lastAt={control?.lastReconciliationRunAt ?? null}
          />
        </section>

        {/* Synthetic uptime */}
        <section className="card">
          <header className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold">Synthetic monitor — last 24 hours</h2>
            {uptimePct !== null && (
              <span
                className={
                  uptimePct >= 95
                    ? "badge-success"
                    : uptimePct >= 80
                    ? "badge-warning"
                    : "badge-danger"
                }
              >
                {uptimePct}% pass
              </span>
            )}
          </header>
          <div className="px-5 py-4">
            {totalRuns === 0 ? (
              <p className="text-sm text-ink-muted">
                No synthetic tests in the last 24 hours yet. Hourly cron has not
                completed a window — check back shortly.
              </p>
            ) : (
              <>
                <SyntheticBar runs={syntheticRows} now={now} />
                <div className="mt-3 flex items-center justify-between text-xs text-ink-muted">
                  <span>{totalRuns} tests run</span>
                  <span>{passRuns} passed · {totalRuns - passRuns} failed</span>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Activity */}
        <section className="card">
          <header className="px-5 py-4 border-b border-border">
            <h2 className="font-semibold">Activity</h2>
          </header>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-5">
            <StatBlock label="Routed last 1h" value={Number(routedLast1h?.n ?? 0)} />
            <StatBlock label="Routed last 24h" value={Number(routedLast24h?.n ?? 0)} />
            <StatBlock label="Completed last 24h" value={Number(completedLast24h?.n ?? 0)} />
            <StatBlock label="In-flight now" value={Number(inFlightNow?.n ?? 0)} />
            <StatBlock
              label="Active partners"
              value={Number(activePartners?.n ?? 0)}
              full
            />
          </div>
        </section>

        <footer className="text-center text-xs text-ink-subtle pt-4">
          <p>
            The Exchange · Public status page · No personal data is exposed on
            this page.
          </p>
        </footer>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function HealthDot({
  health,
  size = "md",
}: {
  health: Health;
  size?: "md" | "lg";
}) {
  const cls = size === "lg" ? "h-4 w-4" : "h-2.5 w-2.5";
  const colour =
    health === "operational"
      ? "bg-green-500"
      : health === "degraded"
      ? "bg-amber-500"
      : "bg-gray-400";
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full ${cls} ${colour}`}
    />
  );
}

function ComponentRow({
  label,
  description,
  health,
  lastAt,
  lastLabel,
}: {
  label: string;
  description: string;
  health: Health;
  lastAt: Date | string | null;
  lastLabel?: string | null;
}) {
  const statusText =
    health === "operational"
      ? "Operational"
      : health === "degraded"
      ? "Degraded"
      : "No data";
  const statusClass =
    health === "operational"
      ? "text-success-fg"
      : health === "degraded"
      ? "text-warning-fg"
      : "text-ink-muted";
  return (
    <div className="px-5 py-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <HealthDot health={health} />
          <span className="font-medium">{label}</span>
        </div>
        <p className="text-xs text-ink-muted mt-1 max-w-md">{description}</p>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-sm font-semibold ${statusClass}`}>{statusText}</div>
        <div className="text-[11px] text-ink-subtle mt-0.5">
          {relativeTime(lastAt)}
          {lastLabel ? <span className="ml-1">· {lastLabel}</span> : null}
        </div>
      </div>
    </div>
  );
}

function SyntheticBar({
  runs,
  now,
}: {
  runs: { outcome: string; ranAt: Date }[];
  now: Date;
}) {
  // 24 hourly buckets, oldest → newest.
  const buckets: { label: string; status: Health; outcome?: string }[] = [];
  for (let i = 23; i >= 0; i--) {
    const start = new Date(now.getTime() - (i + 1) * 60 * 60 * 1000);
    const end = new Date(now.getTime() - i * 60 * 60 * 1000);
    const matching = runs.filter(
      (r) => new Date(r.ranAt) >= start && new Date(r.ranAt) < end,
    );
    if (matching.length === 0) {
      buckets.push({ label: hourLabel(start), status: "no_data" });
    } else {
      const allPass = matching.every(
        (m) => m.outcome === "pushed" || m.outcome === "skipped_no_pair",
      );
      buckets.push({
        label: hourLabel(start),
        status: allPass ? "operational" : "degraded",
        outcome: matching[0].outcome,
      });
    }
  }
  return (
    <div
      className="flex items-end gap-[3px] h-10"
      role="img"
      aria-label={`Synthetic test outcomes for the last 24 hours, oldest to newest`}
    >
      {buckets.map((b, i) => (
        <div
          key={i}
          title={`${b.label} — ${b.outcome ?? "no test"}`}
          className={`flex-1 rounded-sm transition-colors ${
            b.status === "operational"
              ? "bg-green-500 h-full"
              : b.status === "degraded"
              ? "bg-amber-500 h-full"
              : "bg-gray-200 h-1/3 self-end"
          }`}
        />
      ))}
    </div>
  );
}

function hourLabel(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatBlock({
  label,
  value,
  full,
}: {
  label: string;
  value: number;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-2 md:col-span-4" : ""}>
      <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
