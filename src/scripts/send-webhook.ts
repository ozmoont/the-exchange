/**
 * Send a signed test webhook to a deployed Exchange URL, simulating an
 * inbound payload from a connected iCabbi tenant.
 *
 * Usage (defaults to TripStatus → COMPLETED, against the seeded Dublin Cabs):
 *
 *   DATABASE_URL='...' PARTNER_CREDENTIAL_KEY='...' \
 *     APP_URL='https://the-exchange-z2wp.vercel.app' \
 *     pnpm send-webhook --partner dublin
 *
 * Args (all optional except the partner selector):
 *   --partner <name|uuid>     Resolve by exact partner name OR uuid. Required.
 *   --event TripStatus|DriverDetails|FinalFareReleased
 *                             Default: TripStatus
 *   --trip-id <id>            recipientBookingExternalId on a transit you've
 *                             previously routed to this partner. Default: most
 *                             recent transit's recipientBookingExternalId.
 *   --status <STATUS>         Karhoo status string (CONFIRMED, DRIVER_EN_ROUTE,
 *                             ARRIVED, POB, COMPLETED, *_CANCELLED, FAILED, etc).
 *                             Only used by TripStatus. Default: COMPLETED.
 *   --app-url <url>           Override APP_URL env. Default: APP_URL env.
 *   --dry-run                 Print the signed payload + URL but don't POST.
 *
 * Exit code 0 if the route handler responded 200 AND the webhook_deliveries
 * row was updated with a non-error outcome. Exit 1 otherwise — prints the
 * row's outcome for debugging.
 */

import { createHmac, randomBytes } from "node:crypto";
import { db } from "../db/client";
import { partners, transits, webhookDeliveries } from "../db/schema";
import { and, desc, eq, like } from "drizzle-orm";
import { decryptIfNeeded } from "../lib/crypto";

type Args = {
  partner?: string;
  event: "TripStatus" | "DriverDetails" | "FinalFareReleased";
  tripId?: string;
  status: string;
  appUrl: string;
  dryRun: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    partner: undefined,
    event: "TripStatus",
    tripId: undefined,
    status: "COMPLETED",
    appUrl: process.env.APP_URL ?? "http://localhost:3000",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--partner": a.partner = v; i++; break;
      case "--event": a.event = v as Args["event"]; i++; break;
      case "--trip-id": a.tripId = v; i++; break;
      case "--status": a.status = v; i++; break;
      case "--app-url": a.appUrl = v; i++; break;
      case "--dry-run": a.dryRun = true; break;
      default: break;
    }
  }
  if (!a.partner) {
    console.error("Missing --partner <name|uuid>. See header docs.");
    process.exit(2);
  }
  return a;
}

async function resolvePartner(needle: string) {
  // Match by uuid first, fall back to name
  const isUuid = /^[0-9a-f]{8}-/i.test(needle);
  if (isUuid) {
    const [p] = await db.select().from(partners).where(eq(partners.id, needle));
    if (p) return p;
  }
  // Try exact name match
  const [exact] = await db.select().from(partners).where(eq(partners.name, needle));
  if (exact) return exact;
  // Try fuzzy name (case-insensitive prefix)
  const fuzzy = await db
    .select()
    .from(partners)
    .where(like(partners.name, `%${needle}%`))
    .limit(2);
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    console.error(`Multiple partners match "${needle}": ${fuzzy.map((f) => f.name).join(", ")}. Be more specific.`);
    process.exit(2);
  }
  console.error(`No partner matching "${needle}".`);
  process.exit(2);
}

async function resolveTripId(partnerId: string, given?: string): Promise<string> {
  if (given) return given;
  // Use the most recent transit where this partner is the recipient (= the
  // booking we'd be receiving status updates for)
  const [latest] = await db
    .select()
    .from(transits)
    .where(eq(transits.recipientPartnerId, partnerId))
    .orderBy(desc(transits.createdAt))
    .limit(1);
  if (!latest?.recipientBookingExternalId) {
    console.error(
      `No transits with this partner as recipient — can't pick a trip_id automatically. Pass --trip-id explicitly.`,
    );
    process.exit(2);
  }
  return latest.recipientBookingExternalId;
}

function buildEnvelope(args: Args, tripId: string): { envelope: Record<string, unknown>; eventId: string } {
  const eventId = randomBytes(12).toString("hex");
  const now = new Date().toISOString();

  let dataObject: Record<string, unknown>;
  switch (args.event) {
    case "TripStatus":
      dataObject = { trip_id: tripId, status: args.status };
      break;
    case "DriverDetails":
      dataObject = {
        trip_id: tripId,
        description: "Renault Scenic (Black)",
        driver: {
          first_name: "Michael",
          last_name: "Higgins",
          phone_number: "+353 1 555 0099",
          photo_url: "https://example.com/driver.png",
          license_number: "ZXZ151YTY",
        },
        luggage_capacity: 2,
        passenger_capacity: 3,
        vehicle_class: "MPV",
        vehicle_license_plate: "12-D-9999",
        make: "Renault",
        model: "Scenic",
        colour: "BLACK",
        tags: [],
      };
      break;
    case "FinalFareReleased":
      dataObject = { trip_id: tripId };
      break;
  }

  // Karhoo envelope — data is a STRINGIFIED JSON of the inner payload
  const dataString = JSON.stringify(dataObject);

  const envelope = {
    id: eventId,
    event_type: args.event,
    sent_at: now,
    checksum: createHmac("sha512", "checksum-not-verified-by-us").update(dataString).digest("hex"),
    attempt_number: 0,
    data: dataString,
  };

  return { envelope, eventId };
}

function signBody(rawBody: string, secret: string): string {
  return createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
}

async function main() {
  const args = parseArgs();

  const partner = await resolvePartner(args.partner!);
  console.log(`Partner: ${partner.name} (${partner.id})`);

  const creds = decryptIfNeeded(partner.credentials as Record<string, unknown> | null);
  const webhookSecret = (creds?.webhookSecret as string | undefined) ?? "";
  if (!webhookSecret) {
    console.error(
      `Partner has no webhookSecret saved. The partner must be connected via /partners/[id]/integration first.`,
    );
    process.exit(2);
  }

  const tripId = await resolveTripId(partner.id, args.tripId);
  console.log(`Using trip_id: ${tripId}`);

  const { envelope, eventId } = buildEnvelope(args, tripId);
  const rawBody = JSON.stringify(envelope);
  const signature = signBody(rawBody, webhookSecret);

  const url = `${args.appUrl.replace(/\/$/, "")}/api/webhooks/ingest/${partner.id}`;

  console.log(`\nPOST ${url}`);
  console.log(`Signature (X-Karhoo-Request-Signature): ${signature.slice(0, 16)}…${signature.slice(-8)}`);
  console.log(`Event id: ${eventId}`);
  console.log(`Payload (${rawBody.length}b): ${rawBody.slice(0, 200)}${rawBody.length > 200 ? "…" : ""}`);

  if (args.dryRun) {
    console.log("\n--dry-run set — not sending.");
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Karhoo-Request-Signature": signature,
    },
    body: rawBody,
  });

  const text = await res.text();
  console.log(`\nResponse: ${res.status} ${res.statusText}`);
  console.log(text);

  if (!res.ok) {
    console.error("\n❌ Non-2xx response — webhook was rejected.");
    process.exit(1);
  }

  // Wait briefly for the outcome to land in webhook_deliveries
  await new Promise((r) => setTimeout(r, 500));

  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.source, `ingest:${partner.id}`),
        eq(webhookDeliveries.sourceEventId, eventId),
      ),
    );

  if (!delivery) {
    console.error(`\n⚠ No webhook_deliveries row found for event_id=${eventId}. Did the deploy use a different DB?`);
    process.exit(1);
  }

  const outcome = delivery.outcome ?? "(pending)";
  console.log(`\nDB outcome: ${outcome}`);
  if (delivery.processedAt) {
    console.log(`Processed at: ${delivery.processedAt.toISOString()}`);
  }

  if (outcome === "applied" || outcome === "routed" || outcome === "ack_unhandled") {
    console.log("\n✓ Round-trip OK.");
  } else if (outcome === "signature_invalid") {
    console.error("\n❌ Server reports signature_invalid. Local PARTNER_CREDENTIAL_KEY likely differs from the deployed env var.");
    process.exit(1);
  } else if (outcome === "orphan") {
    console.warn("\n⚠ Status update applied to no transit (no transit with that recipient_booking_external_id). Pass --trip-id pointing at an existing transit.");
  } else {
    console.error(`\n⚠ Unexpected outcome: ${outcome}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
