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
const IN_FLIGHT = ["pushed", "accepted", "driver_assigned", "en_route", "on_board"] as const;
const LIFECYCLE_NEXT: Record<string, string> = {
  pushed: "accepted",
  accepted: "driver_assigned",
  driver_assigned: "en_route",
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
}

async function tickOnce(): Promise<void> {
  // Pick a random in-flight transit
  const inFlight = await db
    .select()
    .from(transits)
    .where(inArray(transits.status, IN_FLIGHT as unknown as string[]))
    .limit(20);

  if (inFlight.length > 0) {
    const t = inFlight[Math.floor(Math.random() * inFlight.length)];
    const nextStatus = LIFECYCLE_NEXT[t.status];
    if (!nextStatus) return;

    await db
      .update(transits)
      .set({ status: nextStatus as never, updatedAt: new Date() })
      .where(eq(transits.id, t.id));

    await db.insert(transitEvents).values({
      transitId: t.id,
      status: nextStatus as never,
      detail: { source: "demo_tick" },
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
