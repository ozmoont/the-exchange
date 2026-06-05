/**
 * iCabbi staging end-to-end smoke.
 *
 * Fires a single dummy booking from the FreeNow Dummy partner into the
 * routing engine. The engine should pick one of the two iCabbi staging
 * tenants (COID 1102 or COID 2102) as the recipient and call the real
 * iCabbi staging API to create the booking on their side.
 *
 * Success means we get a real iCabbi response envelope back with
 * body.booking.perma_id and body.booking.trip_id captured on our transit
 * row. From that point a driver-app simulator on the iCabbi side can
 * accept the booking and progress it through the lifecycle — webhook
 * events would flow back to us through /api/webhooks/ingest/<partnerId>.
 *
 * Pre-flight:
 *   1. pnpm seed:icabbi-staging        (creates 3 partner rows + rules)
 *   2. Visit /partners/<id>/integration and paste keys + staging URL
 *      for both COID 1102 and COID 2102 (credentials get encrypted)
 *   3. Run this smoke
 *
 * Usage:
 *   pnpm smoke:icabbi-staging
 *
 * Exits 0 on success with the booking details, non-zero on any failure
 * with diagnostic output.
 */

import { db } from "../db/client";
import { partners, transits, transitEvents } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { routeBooking } from "../lib/routing";
import { decryptIfNeeded } from "../lib/crypto";

const FREENOW_NAME = "FreeNow Dummy (test originator)";
const TENANT_1102 = "iCabbi Staging COID 1102";
const TENANT_2102 = "iCabbi Staging COID 2102";

type ICabbiCreds = {
  appKey?: string;
  secretKey?: string;
  apiBaseUrl?: string;
  webhookSecret?: string;
};

function readCreds(stored: unknown): ICabbiCreds {
  return (decryptIfNeeded(stored as Record<string, unknown> | null) ?? {}) as ICabbiCreds;
}

async function findRequired(name: string) {
  const [row] = await db.select().from(partners).where(eq(partners.name, name));
  if (!row) {
    console.error(`[smoke] partner not found: "${name}"`);
    console.error(`[smoke] run \`pnpm seed:icabbi-staging\` first`);
    process.exit(1);
  }
  return row;
}

async function main() {
  console.log("[smoke] iCabbi staging end-to-end\n");

  // ---- pre-flight checks ----------------------------------------------
  const freenow = await findRequired(FREENOW_NAME);
  const tenant1102 = await findRequired(TENANT_1102);
  const tenant2102 = await findRequired(TENANT_2102);

  let credsMissing = false;
  for (const t of [tenant1102, tenant2102]) {
    const creds = readCreds(t.credentials);
    const hasKeys = !!creds.appKey && !!creds.secretKey;
    const hasUrl = !!creds.apiBaseUrl;
    if (!hasKeys || !hasUrl || t.adapterKey !== "icabbi") {
      console.error(`[smoke] ${t.name}:`);
      if (!hasKeys) console.error(`        ✗ missing App-Key or Secret-Key`);
      if (!hasUrl) console.error(`        ✗ missing apiBaseUrl (set to staging URL)`);
      if (t.adapterKey !== "icabbi")
        console.error(`        ✗ adapter is "${t.adapterKey}", expected "icabbi"`);
      console.error(`        → visit /partners/${t.id}/integration to fix`);
      credsMissing = true;
    } else {
      console.log(`[smoke] ${t.name}: configured (apiBaseUrl=${creds.apiBaseUrl})`);
    }
  }
  if (credsMissing) {
    console.error(
      "\n[smoke] one or more iCabbi tenants is not fully configured. " +
        "Paste credentials via the integration UI before re-running.",
    );
    process.exit(1);
  }

  // ---- fire a booking -------------------------------------------------
  console.log("\n[smoke] firing test booking from FreeNow Dummy → routing engine\n");
  const externalId = `SMOKE-${Date.now()}`;
  const result = await routeBooking({
    originatorPartnerId: freenow.id,
    booking: {
      originatorBookingExternalId: externalId,
      bookingType: "asap",
      channel: "api",
      pickup: {
        lat: 51.507,
        lng: -0.128,
        address: "Trafalgar Square, London WC2N 5DN, UK",
      },
      dropoff: {
        lat: 51.470,
        lng: -0.454,
        address: "Heathrow Terminal 5, Longford TW6 2GA, UK",
      },
      vehicleType: "standard",
      passengerCount: 1,
      fareEstimatePence: 4500,
      passenger: {
        name: "Smoke Test Passenger",
        phone: "+44 7000 000000",
      },
      raw: {
        source: "smoke:icabbi-staging",
        note: "Synthesised by smoke-icabbi-staging.ts — not a real passenger.",
      },
    },
  });

  console.log(`[smoke] routing outcome: ${result.outcome}`);
  console.log(`[smoke] transit id     : ${result.transitId}`);

  // ---- inspect the transit row to confirm what happened ---------------
  const [transit] = await db
    .select()
    .from(transits)
    .where(eq(transits.id, result.transitId));

  if (!transit) {
    console.error("[smoke] transit row not found after routing — unexpected");
    process.exit(1);
  }

  console.log(`[smoke] transit status : ${transit.status}`);
  if (transit.recipientPartnerId) {
    const [recipient] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, transit.recipientPartnerId));
    console.log(`[smoke] recipient      : ${recipient?.name ?? transit.recipientPartnerId}`);
  }
  if (transit.recipientBookingExternalId) {
    console.log(`[smoke] iCabbi perma_id: ${transit.recipientBookingExternalId}`);
  }
  if (transit.partnershipCoid) {
    console.log(`[smoke] partnership coid: ${transit.partnershipCoid}`);
  }
  if (transit.trackMyTaxiLink) {
    console.log(`[smoke] tracking URL   : ${transit.trackMyTaxiLink}`);
  }
  if (transit.feeSnapshot) {
    const fs = transit.feeSnapshot;
    console.log(
      `[smoke] fee snapshot   : send=${fs.sendFeePence}p receive=${fs.receiveFeePence}p`,
    );
  }

  // Latest transit_event for context
  const [latestEvent] = await db
    .select()
    .from(transitEvents)
    .where(eq(transitEvents.transitId, transit.id))
    .orderBy(desc(transitEvents.createdAt))
    .limit(1);
  if (latestEvent) {
    console.log(`[smoke] last event     : ${latestEvent.status}`);
  }

  // ---- pass/fail verdict ----------------------------------------------
  console.log("");
  if (result.outcome === "pushed" && transit.recipientBookingExternalId) {
    console.log("[smoke] ✓ PASS — real iCabbi staging accepted the booking");
    console.log("[smoke]   inspect the transit on the dashboard:");
    console.log(`[smoke]     /transits/${transit.id}`);
    console.log("[smoke]   then drive the lifecycle from the iCabbi side using");
    console.log("[smoke]   the driver app simulator (drivers 147/1889/5200 on 1102,");
    console.log("[smoke]   or driver 999 on 2102).");
    process.exit(0);
  }
  if (result.outcome === "no_match") {
    console.error("[smoke] ✗ FAIL — routing found no eligible candidate");
    console.error("[smoke]   check bilateral allow rules + partner statuses");
    process.exit(2);
  }
  if (result.outcome === "paused") {
    console.error("[smoke] ✗ FAIL — kill switch is engaged");
    console.error("[smoke]   disengage from the dashboard and re-run");
    process.exit(3);
  }
  console.error("[smoke] ✗ FAIL — unexpected outcome / no recipient external id");
  console.error("[smoke]   check the transit detail page for the iCabbi error");
  console.error(`[smoke]     /transits/${transit.id}`);
  process.exit(4);
}

main().catch((err) => {
  console.error("[smoke] crashed with exception:");
  console.error(err);
  process.exit(99);
});
