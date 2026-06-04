/**
 * Visual rendering of the routing waterfall trace stored on transit.routingTrace.
 *
 * Each candidate fleet considered shows up as a row with: rank, fleet name,
 * distance from pickup, fee, outcome (chose / skipped / failed).
 *
 * The "chose" row is highlighted; everything before it shows as a candidate
 * that wasn't picked (in geo+fee scoring, ranked higher candidates always
 * win unless they error — so all skipped attempts are failures). Everything
 * after isn't drawn (waterfall stopped at the winner).
 */

import Link from "next/link";

type Attempt = {
  recipientId: string;
  rank: number;
  score: number;
  distanceKm: number | null;
  receiveFeePence: number;
  outcome: "pushed" | "error_other" | "error_auth";
  error?: string;
};

type RerouteAttempt = {
  recipientId: string;
  rank?: number;
  distanceKm?: number | null;
  receiveFeePence?: number;
  reason: string;
  at: string;
  success?: boolean;
  error?: string;
};

type Trace = {
  consideredCount?: number;
  waterfallAttempts?: Attempt[];
  rerouteAttempts?: RerouteAttempt[];
  winner?: string | null;
  pickupLat?: number;
  pickupLng?: number;
};

export function RoutingTrace({
  trace,
  partnerNames,
}: {
  trace: Record<string, unknown> | null | undefined;
  partnerNames: Map<string, string>;
}) {
  if (!trace) {
    return (
      <p className="text-sm text-ink-muted">
        No routing trace recorded — booking hasn&apos;t reached routing stage.
      </p>
    );
  }

  const t = trace as Trace;
  const attempts = t.waterfallAttempts ?? [];
  const considered = t.consideredCount ?? attempts.length;

  // Legacy traces (from the demo tick or seed) didn't capture attempts —
  // just show the considered count + winner.
  if (attempts.length === 0) {
    return (
      <div className="text-sm text-ink-muted">
        <p>
          <strong>{considered}</strong> eligible fleet{considered === 1 ? "" : "s"} considered.
          {t.winner ? (
            <>
              {" "}Routed to{" "}
              <Link href={`/partners/${t.winner}`} className="text-ink hover:underline">
                {partnerNames.get(t.winner) ?? t.winner.slice(0, 8)}
              </Link>
              .
            </>
          ) : (
            " No eligible partner accepted the job."
          )}
        </p>
        <p className="text-xs text-ink-subtle mt-2">
          (This booking was created before waterfall trace was added — newer bookings show every
          candidate considered.)
        </p>
      </div>
    );
  }

  const fmtMoney = (p: number) => (p >= 1000 ? `£${(p / 100).toFixed(2)}` : `${p}p`);
  const fmtDistance = (km: number | null) => (km == null ? "—" : `${km.toFixed(1)} km`);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between text-sm">
        <p className="text-ink-muted">
          <strong className="text-ink">{considered}</strong> eligible fleet
          {considered === 1 ? "" : "s"} considered ·{" "}
          <strong className="text-ink">{attempts.length}</strong> waterfall attempt
          {attempts.length === 1 ? "" : "s"}
        </p>
        {t.pickupLat != null && t.pickupLng != null && (
          <p className="text-xs text-ink-subtle font-mono">
            pickup {t.pickupLat.toFixed(4)}, {t.pickupLng.toFixed(4)}
          </p>
        )}
      </div>

      <ol className="space-y-2">
        {attempts.map((a) => {
          const isWinner = a.outcome === "pushed";
          const failed = !isWinner;
          return (
            <li
              key={`${a.rank}-${a.recipientId}`}
              className={`relative grid grid-cols-[42px_1fr] gap-3 rounded-md border p-3 ${
                isWinner
                  ? "border-green-300 bg-success/30"
                  : "border-border bg-surface-muted/30"
              }`}
            >
              {/* Rank + outcome indicator */}
              <div className="flex flex-col items-center pt-0.5">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    isWinner
                      ? "bg-green-600 text-white"
                      : failed
                      ? "bg-red-500 text-white"
                      : "bg-surface-muted text-ink"
                  }`}
                  title={
                    isWinner
                      ? "Booked"
                      : a.outcome === "error_auth"
                      ? "Auth failed"
                      : "Adapter error"
                  }
                >
                  {isWinner ? "✓" : a.rank + 1}
                </div>
              </div>

              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <Link
                    href={`/partners/${a.recipientId}`}
                    className="font-semibold text-sm hover:underline truncate"
                  >
                    {partnerNames.get(a.recipientId) ?? a.recipientId.slice(0, 8)}
                  </Link>
                  <span
                    className={`text-xs font-semibold ${
                      isWinner
                        ? "text-green-700"
                        : a.outcome === "error_auth"
                        ? "text-red-700"
                        : "text-red-600"
                    }`}
                  >
                    {isWinner
                      ? "Booked"
                      : a.outcome === "error_auth"
                      ? "Auth failed → fell through"
                      : "Adapter error → fell through"}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
                  <Stat label="Distance" value={fmtDistance(a.distanceKm)} />
                  <Stat label="Fee" value={fmtMoney(a.receiveFeePence)} />
                  <Stat label="Score" value={a.score.toFixed(1)} />
                </div>
                {a.error && (
                  <p className="mt-2 text-xs text-red-700 font-mono break-words">
                    {a.error}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* If consideredCount > attempts.length, we never tried the rest */}
      {considered > attempts.length && (
        <p className="text-xs text-ink-subtle">
          {considered - attempts.length} more eligible fleet
          {considered - attempts.length === 1 ? "" : "s"} not tried — winner found first.
        </p>
      )}

      {/* Auto-reroute history — fired after a fleet failed to accept in time */}
      {t.rerouteAttempts && t.rerouteAttempts.length > 0 && (
        <div className="pt-3 border-t border-border">
          <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold mb-2">
            Auto-reroutes after acceptance timeout
          </p>
          <ol className="space-y-2">
            {t.rerouteAttempts.map((r, i) => (
              <li
                key={`reroute-${i}`}
                className={`relative grid grid-cols-[42px_1fr] gap-3 rounded-md border p-3 ${
                  r.success
                    ? "border-amber-300 bg-warning/30"
                    : "border-border bg-surface-muted/30"
                }`}
              >
                <div className="flex flex-col items-center pt-0.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500 text-white text-xs font-semibold" title="Re-route attempt">
                    ↻
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <Link
                      href={`/partners/${r.recipientId}`}
                      className="font-semibold text-sm hover:underline truncate"
                    >
                      {partnerNames.get(r.recipientId) ?? r.recipientId.slice(0, 8)}
                    </Link>
                    <span className="text-xs text-amber-900 font-medium">
                      {r.success ? "Re-routed" : "Re-route failed"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-ink-muted">
                    Reason: <strong>{r.reason}</strong> · {new Date(r.at).toLocaleTimeString()}
                  </div>
                  {r.error && (
                    <p className="mt-1 text-xs text-red-700 font-mono break-words">
                      {r.error}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="uppercase tracking-wide text-ink-subtle text-[10px] font-semibold">
        {label}
      </div>
      <div className="font-medium text-ink tabular-nums">{value}</div>
    </div>
  );
}
