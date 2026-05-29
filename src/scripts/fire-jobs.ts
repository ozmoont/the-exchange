/**
 * Fire N bookings through the routing engine in bulk. Distribute pickup
 * locations across the UK with realistic clustering (most pickups around
 * cities where most demand is); pick random originators; route through
 * the same routeBooking() the live app uses, so geo + waterfall + fees all
 * exercise exactly as in production.
 *
 * Prints distribution stats at the end: winner counts, no-match counts,
 * top 10 fleets by win count.
 *
 * Usage:
 *   DATABASE_URL='...' PARTNER_CREDENTIAL_KEY='...' pnpm fire-jobs
 *
 *   --count 500          Total bookings to fire. Default 500.
 *   --concurrency 20     Parallel routing attempts. Default 20.
 *   --asap-share 0.7     Fraction of bookings that are ASAP (rest prebook). Default 0.7.
 *   --exec-share 0.15    Fraction requesting exec vehicles. Default 0.15.
 */

import { db } from "../db/client";
import { partners, transits } from "../db/schema";
import { routeBooking } from "../lib/routing";
import { eq, inArray, like, sql } from "drizzle-orm";

type ParsedArgs = {
  count: number;
  concurrency: number;
  asapShare: number;
  execShare: number;
};

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const a: ParsedArgs = { count: 500, concurrency: 20, asapShare: 0.7, execShare: 0.15 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--count") { a.count = Number(argv[i + 1]); i++; }
    else if (arg === "--concurrency") { a.concurrency = Number(argv[i + 1]); i++; }
    else if (arg === "--asap-share") { a.asapShare = Number(argv[i + 1]); i++; }
    else if (arg === "--exec-share") { a.execShare = Number(argv[i + 1]); i++; }
  }
  return a;
}

// Realistic UK pickup hotspots — weighted to match population centres
const HOTSPOTS = [
  { name: "London city centre",       lat: 51.507, lng: -0.128, weight: 28 },
  { name: "Heathrow",                 lat: 51.470, lng: -0.454, weight: 10 },
  { name: "Gatwick",                  lat: 51.153, lng: -0.182, weight: 6 },
  { name: "London suburbs",           lat: 51.530, lng: -0.350, weight: 12 },
  { name: "Manchester city",          lat: 53.481, lng: -2.244, weight: 12 },
  { name: "Manchester Airport",       lat: 53.357, lng: -2.275, weight: 5 },
  { name: "Birmingham city",          lat: 52.486, lng: -1.890, weight: 12 },
  { name: "Leeds city",               lat: 53.801, lng: -1.549, weight: 8 },
  { name: "Glasgow city",             lat: 55.864, lng: -4.252, weight: 8 },
  { name: "Liverpool city",           lat: 53.408, lng: -2.991, weight: 7 },
  { name: "Edinburgh city",           lat: 55.953, lng: -3.188, weight: 6 },
  { name: "Sheffield city",           lat: 53.381, lng: -1.470, weight: 5 },
  { name: "Bristol city",             lat: 51.454, lng: -2.587, weight: 5 },
  { name: "Newcastle city",           lat: 54.978, lng: -1.617, weight: 4 },
  { name: "Nottingham city",          lat: 52.954, lng: -1.158, weight: 4 },
  { name: "Cardiff city",             lat: 51.481, lng: -3.179, weight: 4 },
  { name: "Belfast city",             lat: 54.597, lng: -5.930, weight: 4 },
  { name: "Leicester city",           lat: 52.637, lng: -1.139, weight: 3 },
  { name: "Brighton",                 lat: 50.823, lng: -0.143, weight: 3 },
  { name: "Southampton",              lat: 50.909, lng: -1.404, weight: 2 },
  { name: "Plymouth",                 lat: 50.376, lng: -4.143, weight: 2 },
  { name: "Cambridge",                lat: 52.205, lng: 0.122,  weight: 2 },
  { name: "Oxford",                   lat: 51.752, lng: -1.258, weight: 2 },
  { name: "Aberdeen",                 lat: 57.149, lng: -2.094, weight: 2 },
];

function pickHotspot() {
  const total = HOTSPOTS.reduce((s, h) => s + h.weight, 0);
  let pick = Math.random() * total;
  for (const h of HOTSPOTS) {
    pick -= h.weight;
    if (pick <= 0) return h;
  }
  return HOTSPOTS[0];
}

function jitter(lat: number, lng: number, km: number): { lat: number; lng: number } {
  // Approximate degree-per-km at Irish latitudes
  const dLat = (km / 111) * (Math.random() - 0.5);
  const dLng = (km / 67) * (Math.random() - 0.5);
  return { lat: lat + dLat, lng: lng + dLng };
}

async function main() {
  const args = parseArgs();
  console.log(`Firing ${args.count} jobs (concurrency=${args.concurrency}, asap=${args.asapShare}, exec=${args.execShare})...`);

  const originators = await db
    .select()
    .from(partners)
    .where(eq(partners.status, "active"));

  if (originators.length === 0) {
    console.error("No active partners to use as originators. Run `pnpm spawn-fleets` first.");
    process.exit(2);
  }
  console.log(`  ${originators.length} active partners available as originators`);

  const startTime = Date.now();
  const outcomes = { pushed: 0, no_match: 0, paused: 0, error: 0 };
  const winnerCounts = new Map<string, number>();

  let nextIdx = 0;
  const workers: Promise<void>[] = [];

  async function fireOne(idx: number) {
    const originator = originators[Math.floor(Math.random() * originators.length)];
    const pickup = pickHotspot();
    const dropoff = pickHotspot();
    const pickupJittered = jitter(pickup.lat, pickup.lng, 3);
    const dropoffJittered = jitter(dropoff.lat, dropoff.lng, 5);

    const bookingType: "asap" | "prebook" = Math.random() < args.asapShare ? "asap" : "prebook";
    const vehicleType = Math.random() < args.execShare ? "exec" : "standard";
    const fareEstimatePence = 1000 + Math.floor(Math.random() * 6000);

    try {
      const result = await routeBooking({
        originatorPartnerId: originator.id,
        booking: {
          originatorBookingExternalId: `FIRE-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          bookingType,
          channel: "api",
          pickup: { lat: pickupJittered.lat, lng: pickupJittered.lng, address: pickup.name },
          dropoff: { lat: dropoffJittered.lat, lng: dropoffJittered.lng, address: dropoff.name },
          scheduledFor: bookingType === "prebook" ? new Date(Date.now() + 3600_000).toISOString() : undefined,
          vehicleType,
          passengerCount: 1 + Math.floor(Math.random() * 3),
          fareEstimatePence,
          passenger: { name: "Load Test", phone: "+353 1 555 0000" },
          raw: { source: "fire_jobs" },
        },
      });
      outcomes[result.outcome]++;
      if (result.outcome === "pushed") {
        // Look up the winner from the transit
        const [t] = await db.select().from(transits).where(eq(transits.id, result.transitId));
        if (t?.recipientPartnerId) {
          winnerCounts.set(t.recipientPartnerId, (winnerCounts.get(t.recipientPartnerId) ?? 0) + 1);
        }
      }
    } catch (err) {
      outcomes.error++;
      console.error(`  job ${idx} threw:`, err instanceof Error ? err.message : err);
    }

    if (idx % 25 === 0 || idx === args.count - 1) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (idx + 1) / elapsed;
      process.stdout.write(
        `  ${idx + 1}/${args.count} (${rate.toFixed(1)}/s) pushed=${outcomes.pushed} no_match=${outcomes.no_match} err=${outcomes.error}    \r`,
      );
    }
  }

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= args.count) return;
      await fireOne(idx);
    }
  }

  for (let i = 0; i < args.concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const totalElapsed = (Date.now() - startTime) / 1000;

  console.log("\n\n=== Distribution ===");
  console.log(`Total: ${args.count} bookings in ${totalElapsed.toFixed(1)}s (${(args.count / totalElapsed).toFixed(1)}/s)`);
  console.log(`Outcomes:`);
  console.log(`  pushed:    ${outcomes.pushed}`);
  console.log(`  no_match:  ${outcomes.no_match}`);
  console.log(`  paused:    ${outcomes.paused}`);
  console.log(`  error:     ${outcomes.error}`);
  console.log(`\nTop 10 winning fleets:`);
  const ranked = [...winnerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (ranked.length === 0) {
    console.log("  (none)");
  } else {
    const ids = ranked.map(([id]) => id);
    const namedRows = await db.select().from(partners).where(inArray(partners.id, ids));
    const nameById = new Map(namedRows.map((r) => [r.id, r.name]));
    for (const [id, count] of ranked) {
      const pct = ((count / outcomes.pushed) * 100).toFixed(1);
      console.log(`  ${nameById.get(id) ?? id.slice(0, 8)}: ${count} (${pct}%)`);
    }
  }

  // Concentration: what share of pushed jobs did the top 10% of fleets win?
  if (winnerCounts.size > 0) {
    const sorted = [...winnerCounts.values()].sort((a, b) => b - a);
    const topPct = Math.max(1, Math.ceil(sorted.length * 0.1));
    const topShare = sorted.slice(0, topPct).reduce((s, n) => s + n, 0) / outcomes.pushed;
    console.log(`\nConcentration: top 10% of winning fleets took ${(topShare * 100).toFixed(1)}% of routed jobs`);
    console.log(`Unique winners: ${winnerCounts.size} of ${originators.length} active partners`);
  }

  // Quick suppress unused-import warning for SQL helpers in case of further changes
  void sql;
  void like;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
