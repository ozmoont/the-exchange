import { db } from "@/db/client";
import { partners, transits, transitEvents, networkControls } from "@/db/schema";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";

/**
 * Demo-mode background activity.
 *
 * When DISABLE_AUTH=true, this function is called from the root layout on
 * every page render. With a 20-second cooldown enforced in the DB, it ticks
 * one in-flight transit forward in its lifecycle (pushed → accepted →
 * driver_assigned → en_route → on_board → completed), writing the matching
 * transit_event. If no transit is in flight, it spawns a fresh one from a
 * random originator/recipient pair.
 *
 * Combined with the LiveRefresh client component (10s router.refresh()),
 * the live URL visibly tickets activity to anyone viewing — Frank lands on
 * the dashboard, sees a transit advance mid-conversation, asks how it works.
 *
 * Always returns quickly. Worst case: one SELECT (cooldown check). When a
 * tick fires: one SELECT (in-flight transits), one UPDATE (transit status),
 * one INSERT (transit event), one UPDATE (lastDemoTickAt).
 */

const COOLDOWN_MS = 20_000;
const IN_FLIGHT = ["pushed", "accepted", "driver_assigned", "driver_arrived", "en_route", "on_board"] as const;
const LIFECYCLE_NEXT: Record<string, string> = {
  pushed: "accepted",
  accepted: "driver_assigned",
  driver_assigned: "driver_arrived",
  driver_arrived: "en_route",
  en_route: "on_board",
  on_board: "completed",
};

export async function maybeTickDemoMode(): Promise<void> {
  if (process.env.DISABLE_AUTH !== "true") return;

  const [control] = await db.select().from(networkControls).where(eq(networkControls.id, "global"));
  const now = new Date();
  const lastTick = control?.lastDemoTickAt;
  if (lastTick && now.getTime() - lastTick.getTime() < COOLDOWN_MS) return;

  // Don't tick when the kill switch is engaged — would look weird if "network
  // paused" was on the dashboard while a transit advanced anyway.
  if (control?.killSwitch) return;

  // Claim the tick by updating lastDemoTickAt FIRST. Races are rare and
  // harmless — at worst two requests both update transits, which just makes
  // the demo more active for a second.
  await db
    .update(networkControls)
    .set({ lastDemoTickAt: now })
    .where(eq(networkControls.id, "global"));

  try {
    await tickOnce();
  } catch (err) {
    console.warn("[demo] tick failed:", err instanceof Error ? err.message : err);
  }

  // Also enforce the acceptance window. In production this will be a Vercel
  // cron; for demo mode we piggyback on the same cooldown so the dashboard
  // shows live reroutes happening alongside the lifecycle advances.
  try {
    const { recheckStaleAcceptances } = await import("@/lib/reroute");
    const outcomes = await recheckStaleAcceptances();
    if (outcomes.length > 0) {
      const rerouted = outcomes.filter((o) => o.outcome === "rerouted").length;
      if (rerouted > 0) console.log(`[demo] rerouted ${rerouted} stale-accept transit(s)`);
    }
  } catch (err) {
    console.warn("[demo] reroute check failed:", err instanceof Error ? err.message : err);
  }
}

async function tickOnce(): Promise<void> {
  // Pick a random in-flight transit
  const inFlight = await db
    .select()
    .from(transits)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .where(inArray(transits.status as any, [...IN_FLIGHT]))
    .limit(20);

  if (inFlight.length > 0) {
    const t = inFlight[Math.floor(Math.random() * inFlight.length)];
    const nextStatus = LIFECYCLE_NEXT[t.status];
    if (!nextStatus) return;

    await db
      .update(transits)
      .set({ status: nextStatus as never, updatedAt: new Date() })
      .where(eq(transits.id, t.id));

    // When the demo lifecycle reaches driver_assigned, attach a fake driver
    // payload so the driver panel surfaces. Shape mirrors Karhoo DriverDetails.
    const detail: Record<string, unknown> =
      nextStatus === "driver_assigned"
        ? { source: "demo_tick", ...sampleDriver() }
        : { source: "demo_tick" };

    await db.insert(transitEvents).values({
      transitId: t.id,
      status: nextStatus as never,
      detail,
      actor: "system",
    });
    return;
  }

  // Nothing in flight — spawn a new pushed transit
  await spawnDemoTransit();
}

async function spawnDemoTransit(): Promise<void> {
  const activePartners = await db
    .select()
    .from(partners)
    .where(eq(partners.status, "active"))
    .limit(10);

  if (activePartners.length < 2) return; // need at least 2 for a route

  // Filter out duplicates and pick an originator + a different recipient
  const originator = activePartners[Math.floor(Math.random() * activePartners.length)];
  const candidates = activePartners.filter((p) => p.id !== originator.id);
  if (candidates.length === 0) return;
  const recipient = candidates[Math.floor(Math.random() * candidates.length)];

  const externalId = `DEMO-${Date.now()}-${randomBytes(2).toString("hex")}`;
  const recipientExternalId = `icabbi-${recipient.name.toLowerCase().split(" ")[0]}-${externalId.slice(-6)}`;

  const fareEstimatePence = recipient.kind === "external_corporate" ? 3500 + Math.floor(Math.random() * 3000) : undefined;

  await db.insert(transits).values({
    originatorPartnerId: originator.id,
    originatorBookingExternalId: externalId,
    recipientPartnerId: recipient.id,
    recipientBookingExternalId: recipientExternalId,
    status: "pushed",
    bookingPayload: {
      originatorBookingExternalId: externalId,
      bookingType: recipient.kind === "external_corporate" ? "prebook" : "asap",
      channel: "app",
      pickup: { lat: 53.349, lng: -6.26, address: pickRandom(PICKUPS) },
      dropoff: { lat: 53.421, lng: -6.27, address: pickRandom(DROPOFFS) },
      vehicleType: recipient.kind === "external_corporate" ? "executive" : "standard",
      passengerCount: 1,
      fareEstimatePence,
      passenger: { name: "Demo Passenger", phone: "+353 1 000 0000" },
      raw: { source: "demo_tick" },
    },
    feeSnapshot: {
      sendFeePence: recipient.kind === "external_corporate" ? 20 : 15,
      receiveFeePence: recipient.kind === "external_corporate" ? 50 : 30,
      techFeePence: recipient.kind === "external_corporate" ? 100 : 0,
      techFeeBps: 0,
      bookingFeePence: recipient.kind === "external_corporate" ? 200 : 0,
      adminFeePence: 0,
      adminFeeBps: recipient.kind === "external_corporate" ? 300 : 0,
      computedPassengerAddOnsPence:
        recipient.kind === "external_corporate"
          ? 100 + 200 + Math.round(((fareEstimatePence ?? 0) * 300) / 10000)
          : 0,
      fareAtSnapshotPence: fareEstimatePence ?? null,
      resolvedFromFeeConfigId: "demo_tick",
    },
    routingTrace: { source: "demo_tick", winner: recipient.id },
  });
}

const PICKUPS = [
  "Grafton St, Dublin",
  "Trinity College, Dublin",
  "Connolly Station, Dublin",
  "The Shelbourne Hotel, Dublin",
  "Patrick St, Cork",
  "UCC, Cork",
  "The Marker Hotel, Dublin",
  "Heuston Station, Dublin",
];

const DROPOFFS = [
  "Dublin Airport",
  "Cork Airport",
  "Croke Park",
  "Aviva Stadium",
  "Phoenix Park",
  "Sandymount Strand",
  "Howth Village",
  "Dun Laoghaire Pier",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Sample driver+vehicle data mirroring Karhoo's DriverDetails webhook payload.
 * Used when the demo tick advances a transit to `driver_assigned`, so the
 * Driver panel on the transit detail page has something concrete to show.
 */
function sampleDriver() {
  const samples = [
    {
      driver: { first_name: "James", last_name: "Carter", phone_number: "+44 20 7946 0099", license_number: "GB-PHV-9981" },
      description: "Renault Scenic (Black)",
      vehicle_class: "MPV",
      vehicle_license_plate: "LK22 XAB",
      make: "Renault",
      model: "Scenic",
      colour: "BLACK",
      passenger_capacity: 4,
      luggage_capacity: 3,
      tags: ["child-seat"],
    },
    {
      driver: { first_name: "Aisha", last_name: "Patel", phone_number: "+44 161 555 0123", license_number: "GB-PHV-3412" },
      description: "Skoda Octavia (Silver)",
      vehicle_class: "Saloon",
      vehicle_license_plate: "MA23 PYR",
      make: "Skoda",
      model: "Octavia",
      colour: "SILVER",
      passenger_capacity: 4,
      luggage_capacity: 3,
      tags: [],
    },
    {
      driver: { first_name: "Daniel", last_name: "O'Connor", phone_number: "+44 121 555 0188", license_number: "GB-PHV-7720" },
      description: "Mercedes E-Class (Black)",
      vehicle_class: "Executive",
      vehicle_license_plate: "BW73 EVK",
      make: "Mercedes-Benz",
      model: "E-Class",
      colour: "BLACK",
      passenger_capacity: 4,
      luggage_capacity: 2,
      tags: ["electric", "premium"],
    },
    {
      driver: { first_name: "Sophie", last_name: "Wright", phone_number: "+44 113 555 0254", license_number: "GB-PHV-1102" },
      description: "Toyota Prius (White)",
      vehicle_class: "Saloon",
      vehicle_license_plate: "LS24 TPS",
      make: "Toyota",
      model: "Prius",
      colour: "WHITE",
      passenger_capacity: 4,
      luggage_capacity: 2,
      tags: ["hybrid"],
    },
  ];
  return pickRandom(samples);
}
