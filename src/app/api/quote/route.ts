import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticateInboundCaller } from "@/lib/icabbi-inbound-auth";
import { normaliseICabbiInboundBooking, type ICabbiInboundBooking } from "@/lib/icabbi-payload";
import { fanOutQuote, QUOTE_FANOUT_TIMEOUT_MS } from "@/lib/fan-out-quote";
import { rankCandidates } from "@/lib/routing";
import { checkRateLimit, LIMIT_INGEST_PER_PARTNER, WINDOW_INGEST_SECONDS } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

/**
 * POST /api/quote — Tier-1 #3.
 *
 * Per iCabbi BDD Section 1.3 dual API surface + Epic 1.2 / 2.2 fan-out NFR.
 * An external partner (or iCabbi acting as fleet-side caller) asks: "Can
 * you fulfil this booking? What's your ETA and price?"
 *
 * We run the fan-out across every eligible recipient and return an
 * aggregate: any partner available, best ETA, candidate count, plus the
 * per-candidate breakdown for callers who want to see the detail.
 *
 * No booking is created. This is a read-only availability query.
 *
 * Auth: same Bearer-token model as /api/icabbi/bookings.
 * Rate limit: 60/min per caller (default).
 * Response budget: <2s per BDD NFR (composed of <1500ms fan-out + ~200ms
 *   candidate lookup + ~50ms response build).
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateInboundCaller(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const callerPartner = auth.partner;

  const rl = await checkRateLimit(
    `quote:${callerPartner.id}`,
    Number(process.env.WEBHOOK_INGEST_RATE_LIMIT ?? LIMIT_INGEST_PER_PARTNER),
    WINDOW_INGEST_SECONDS,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } },
    );
  }

  let raw: ICabbiInboundBooking;
  try {
    raw = (await req.json()) as ICabbiInboundBooking;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "invalid_envelope_shape" }, { status: 400 });
  }

  const normalised = normaliseICabbiInboundBooking(raw);
  if (!normalised.ok) {
    return NextResponse.json(
      { error: normalised.error, missingFields: normalised.missingFields },
      { status: 400 },
    );
  }

  // Rank eligible candidates first — same filter chain as routing
  // (loop detection, bilateral rules, geo, vehicle type). We need the
  // candidates' centroids for the synthetic-ETA fallback.
  const candidates = await rankCandidates(callerPartner.id, normalised.booking);
  if (candidates.length === 0) {
    return NextResponse.json(
      {
        available: false,
        candidates: 0,
        reason: "no_eligible_partners",
      },
      { status: 200 },
    );
  }

  // We need centroidLat/Lng for the fan-out's synthetic-ETA fallback.
  // RankedCandidate doesn't carry that today; pull from a lighter lookup.
  const { db } = await import("@/db/client");
  const { partners } = await import("@/db/schema");
  const { inArray } = await import("drizzle-orm");
  const candidateRows = await db
    .select({ id: partners.id, centroidLat: partners.centroidLat, centroidLng: partners.centroidLng })
    .from(partners)
    .where(inArray(partners.id, candidates.map((c) => c.recipientId)));
  const centroidsById = new Map(candidateRows.map((r) => [r.id, r]));

  const fanOutInput = candidates.map((c) => {
    const cent = centroidsById.get(c.recipientId);
    return {
      recipientId: c.recipientId,
      centroidLat: cent?.centroidLat ?? null,
      centroidLng: cent?.centroidLng ?? null,
    };
  });

  const quotes = await fanOutQuote(fanOutInput, normalised.booking);

  // Aggregate the response — best ETA among available, full breakdown for
  // callers that want it.
  const available = quotes.filter((q) => q.quote.available);
  const bestEta = available
    .map((q) => q.quote.etaMinutes ?? Infinity)
    .reduce((a, b) => Math.min(a, b), Infinity);

  log.info("quote completed", {
    area: "quote",
    caller_partner_id: callerPartner.id,
    candidates: candidates.length,
    available: available.length,
    best_eta_minutes: Number.isFinite(bestEta) ? bestEta : null,
    fanout_timeout_ms: QUOTE_FANOUT_TIMEOUT_MS,
  });

  return NextResponse.json(
    {
      available: available.length > 0,
      candidates: candidates.length,
      available_partners: available.length,
      best_eta_minutes: Number.isFinite(bestEta) ? bestEta : null,
      // Per-candidate breakdown. Sorted by ETA ascending (best first).
      partners: quotes
        .slice()
        .sort(
          (a, b) =>
            (a.quote.etaMinutes ?? Infinity) - (b.quote.etaMinutes ?? Infinity),
        )
        .map((q) => ({
          recipient_id: q.recipientId,
          available: q.quote.available,
          eta_minutes: q.quote.etaMinutes ?? null,
          fare_estimate_pence: q.quote.fareEstimatePence ?? null,
          currency: q.quote.currency ?? "GBP",
          reason: q.quote.reason ?? null,
          elapsed_ms: q.elapsedMs,
          from_adapter: q.fromAdapter,
        })),
    },
    { status: 200 },
  );
}
