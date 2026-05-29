/**
 * Shared fire-jobs logic used by both the CLI script (src/scripts/fire-jobs.ts)
 * and the in-app "Fire N jobs" button on /distribution.
 *
 * Generates random pickup/dropoff coordinates around UK hotspots, picks a
 * random active originator, and routes through routeBooking() — the same
 * code path real iCabbi webhooks travel.
 *
 * Returns a summary object so callers can show a toast/banner.
 */

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { eq } from "drizzle-orm";
import { routeBooking } from "@/lib/routing";

// UK pickup hotspots — keep in lockstep with src/scripts/fire-jobs.ts so the
// CLI and UI button produce the same distribution.
export const UK_HOTSPOTS = [
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
  const total = UK_HOTSPOTS.reduce((s, h) => s + h.weight, 0);
  let pick = Math.random() * total;
  for (const h of UK_HOTSPOTS) {
    pick -= h.weight;
    if (pick <= 0) return h;
  }
  return UK_HOTSPOTS[0];
}

function jitter(lat: number, lng: number, km: number): { lat: number; lng: number } {
  const dLat = (km / 111) * (Math.random() - 0.5);
  const dLng = (km / 67) * (Math.random() - 0.5);
  return { lat: lat + dLat, lng: lng + dLng };
}

export type FireJobsResult = {
  attempted: number;
  pushed: number;
  no_match: number;
  paused: number;
  error: number;
  elapsedMs: number;
};

export type FireJobsOptions = {
  count: number;
  asapShare?: number;  // 0..1 — fraction asap vs prebook
  execShare?: number;  // 0..1 — fraction exec vs standard
  concurrency?: number;
};

/**
 * Fire N jobs through the routing engine. Same code path as the CLI script.
 * Returns aggregate outcome counts.
 */
export async function fireJobs(opts: FireJobsOptions): Promise<FireJobsResult> {
  const { count, asapShare = 0.7, execShare = 0.15, concurrency = 10 } = opts;
  const startTime = Date.now();

  const originators = await db
    .select()
    .from(partners)
    .where(eq(partners.status, "active"));

  if (originators.length === 0) {
    return { attempted: 0, pushed: 0, no_match: 0, paused: 0, error: 0, elapsedMs: 0 };
  }

  const outcomes = { pushed: 0, no_match: 0, paused: 0, error: 0 };
  let nextIdx = 0;

  async function fireOne(idx: number) {
    const originator = originators[Math.floor(Math.random() * originators.length)];
    const pickup = pickHotspot();
    const dropoff = pickHotspot();
    const pickupJittered = jitter(pickup.lat, pickup.lng, 3);
    const dropoffJittered = jitter(dropoff.lat, dropoff.lng, 5);

    const bookingType: "asap" | "prebook" = Math.random() < asapShare ? "asap" : "prebook";
    const vehicleType = Math.random() < execShare ? "exec" : "standard";
    const fareEstimatePence = 1000 + Math.floor(Math.random() * 6000);

    try {
      const result = await routeBooking({
        originatorPartnerId: originator.id,
        booking: {
          originatorBookingExternalId: `UI-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          bookingType,
          channel: "api",
          pickup: { lat: pickupJittered.lat, lng: pickupJittered.lng, address: pickup.name },
          dropoff: { lat: dropoffJittered.lat, lng: dropoffJittered.lng, address: dropoff.name },
          scheduledFor: bookingType === "prebook" ? new Date(Date.now() + 3600_000).toISOString() : undefined,
          vehicleType,
          passengerCount: 1 + Math.floor(Math.random() * 3),
          fareEstimatePence,
          passenger: { name: "Demo Passenger", phone: "+44 20 0000 0000" },
          raw: { source: "fire_jobs_ui" },
        },
      });
      outcomes[result.outcome]++;
    } catch {
      outcomes.error++;
    }
  }

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= count) return;
      await fireOne(idx);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return {
    attempted: count,
    ...outcomes,
    elapsedMs: Date.now() - startTime,
  };
}
