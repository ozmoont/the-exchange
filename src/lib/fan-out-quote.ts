/**
 * Tier-1 #3 — Parallel quote fan-out across eligible recipients.
 *
 * Implements iCabbi BDD Epic 1.2 / 2.2 + the NFR:
 *   "All connected partners queried simultaneously, not sequentially.
 *    Total response collection window: 1500ms maximum."
 *
 * Calls quote() on every eligible candidate in parallel with a 1500ms
 * timeout. Adapters that don't implement quote get a synthetic fallback
 * (always available, ETA estimated from straight-line distance at
 * 30km/h average — slow enough to be conservative). Failures, slow
 * responses, and unavailable partners are surfaced as `available: false`
 * so callers can filter cleanly.
 *
 * Returns the raw per-candidate map; ranking is a separate concern.
 */

import { getAdapterForPartner } from "@/adapters/registry";
import { haversineKm } from "@/lib/routing";
import { log } from "@/lib/logger";
import type { NormalisedBooking, QuoteResult } from "@/lib/types";

/** BDD NFR: total response collection window 1500ms max. */
export const QUOTE_FANOUT_TIMEOUT_MS = 1500;

/** Synthetic ETA derivation when an adapter doesn't quote: 30km/h average. */
const SYNTHETIC_KMH = 30;
const MIN_SYNTHETIC_ETA_MIN = 2;
const MAX_SYNTHETIC_ETA_MIN = 60;

export type FanOutCandidate = {
  recipientId: string;
  /** Where the candidate is centred — used for distance/synthetic ETA. */
  centroidLat: number | null;
  centroidLng: number | null;
};

export type FanOutQuoteResult = {
  recipientId: string;
  /** What the adapter (or fallback) returned. */
  quote: QuoteResult;
  /** True iff the adapter actually called out (vs. fallback). */
  fromAdapter: boolean;
  /** Milliseconds elapsed waiting for the quote. */
  elapsedMs: number;
  /** Set when the quote call threw or timed out. */
  error?: string;
};

/**
 * Run quote() on every candidate in parallel. Returns one result per
 * candidate, in input order (not response order). Never throws.
 */
export async function fanOutQuote(
  candidates: FanOutCandidate[],
  booking: NormalisedBooking,
): Promise<FanOutQuoteResult[]> {
  if (candidates.length === 0) return [];

  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    candidates.map((c) => quoteOne(c, booking)),
  );
  const elapsedTotal = Date.now() - startedAt;

  log.info("fan-out quote complete", {
    area: "fan-out-quote",
    candidates: candidates.length,
    elapsed_ms: elapsedTotal,
  });

  return settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    // Should never happen — quoteOne catches internally.
    return {
      recipientId: candidates[i].recipientId,
      quote: { available: false, reason: "fan_out_internal_error" },
      fromAdapter: false,
      elapsedMs: 0,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });
}

async function quoteOne(
  candidate: FanOutCandidate,
  booking: NormalisedBooking,
): Promise<FanOutQuoteResult> {
  const startedAt = Date.now();
  try {
    const adapter = await getAdapterForPartner(candidate.recipientId);
    if (typeof adapter.quote !== "function") {
      // Synthetic fallback — adapter doesn't expose a quote API.
      return {
        recipientId: candidate.recipientId,
        quote: syntheticQuote(candidate, booking),
        fromAdapter: false,
        elapsedMs: Date.now() - startedAt,
      };
    }
    // Race the adapter's quote against the fan-out timeout. Wrap in
    // Promise.race so a single slow adapter can't delay the whole batch.
    const timeoutPromise = new Promise<QuoteResult>((_, reject) => {
      setTimeout(() => reject(new Error("quote_timeout")), QUOTE_FANOUT_TIMEOUT_MS);
    });
    const result = await Promise.race([
      adapter.quote({ booking }),
      timeoutPromise,
    ]);
    return {
      recipientId: candidate.recipientId,
      quote: result,
      fromAdapter: true,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Treat timeout / crash as unavailable rather than dropping the
    // candidate entirely. The downstream ranking will deprioritise them.
    return {
      recipientId: candidate.recipientId,
      quote: {
        available: false,
        reason: msg.includes("timeout") ? "quote_timeout" : "quote_error",
      },
      fromAdapter: true,
      elapsedMs: Date.now() - startedAt,
      error: msg,
    };
  }
}

/**
 * Synthetic quote for adapters without a real quote() implementation.
 * Always available, ETA derived from straight-line distance at 30km/h
 * (conservative — real routes are slower than crow-flies). Pickup or
 * partner without a centroid → use a neutral 10-minute ETA.
 */
function syntheticQuote(
  candidate: FanOutCandidate,
  booking: NormalisedBooking,
): QuoteResult {
  if (candidate.centroidLat === null || candidate.centroidLng === null) {
    return { available: true, etaMinutes: 10 };
  }
  const distanceKm = haversineKm(
    booking.pickup.lat,
    booking.pickup.lng,
    candidate.centroidLat,
    candidate.centroidLng,
  );
  const rawEtaMin = (distanceKm / SYNTHETIC_KMH) * 60;
  const eta = Math.max(MIN_SYNTHETIC_ETA_MIN, Math.min(rawEtaMin, MAX_SYNTHETIC_ETA_MIN));
  return { available: true, etaMinutes: Math.round(eta) };
}
