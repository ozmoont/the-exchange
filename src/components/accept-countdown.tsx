"use client";

import { useEffect, useState } from "react";

/**
 * Live-counts down to the acceptance deadline for a booking sitting in
 * `pushed` status. Updates every second client-side; once it expires it
 * keeps showing "Window expired — awaiting reroute" until the next router
 * refresh (LiveRefresh) pulls the new state.
 *
 * Pure client component — server-rendered initial value avoids any flash.
 */
export function AcceptCountdown({ deadlineIso }: { deadlineIso: string }) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const deadlineMs = new Date(deadlineIso).getTime();
  const remainingMs = deadlineMs - now;

  if (remainingMs <= 0) {
    return (
      <span className="text-xs text-warning-fg font-medium">
        Window expired — awaiting reroute
      </span>
    );
  }

  const remainingSec = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const display = mins > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;

  // Tone changes as deadline approaches
  const tone =
    remainingSec < 15
      ? "text-red-700"
      : remainingSec < 30
      ? "text-warning-fg"
      : "text-info-fg";

  return (
    <span className={`text-xs font-medium tabular-nums ${tone}`}>
      Awaiting fleet acceptance · {display} remaining
    </span>
  );
}
