/**
 * Seed the CMAC test partner.
 *
 * First real consumer of the H2 mapping engine (Epic 3). Creates a CMAC
 * partner row with:
 *   - kind: external_aggregator
 *   - adapterKey: generic_mapped (no CMAC-specific TypeScript)
 *   - authMechanism: basic (CMAC's HTTP Basic auth)
 *   - credentials: encrypted username/password from CMAC's developer
 *     portal (test account UUIDs)
 *   - fieldMappings: full canonical → CMAC translation (vehicle types,
 *     status enum, endpoint URLs)
 *
 * Also wires bilateral allow rules with:
 *   - iCabbi Staging COID 1102 (so routing can waterfall between them)
 *   - iCabbi Staging COID 2102
 *   - FreeNow Dummy (test originator)
 *
 * Idempotent: re-running is safe. Partner is looked up by name and
 * updated in-place; rules are upserted by primary key.
 *
 * Test credentials are checked into the script because CMAC's developer
 * portal explicitly issued them as test-account credentials. They are
 * still encrypted at rest via PARTNER_CREDENTIAL_KEY so a DB dump
 * doesn't leak them.
 *
 * See docs/CMAC_INTEGRATION.md for what's confirmed vs. assumed about
 * CMAC's API shape.
 *
 * Usage:
 *   pnpm seed:cmac-test
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { partners, partnerRules, feeConfigs } from "../db/schema";
import { encryptCredentials } from "../lib/crypto";

const CMAC_BASE_URL = "https://testapi.cmacgroup.com";

// Test account credentials. CMAC issues these as long-lived UUIDs from
// their developer portal. Not real customer credentials — safe to
// commit, but still encrypted at rest so the DB dump doesn't leak them.
const CMAC_TEST_USERNAME = "ebd3ba71-d6fc-4316-8361-84660880c5cf";
const CMAC_TEST_PASSWORD = "478e923c-fb5a-495d-9872-3820826f82b5";

// ---------------------------------------------------------------------------
// Mapping config — the heart of CMAC integration. No CMAC-specific code
// anywhere else in the repo; this object drives the entire translation.
//
// What's confirmed vs. assumed: see docs/CMAC_INTEGRATION.md. Field names
// marked "assumed" below are placeholders chosen from common REST
// conventions — first live call will tell us what to rename. Rename in
// the UI at /partners/<id>/mappings, no code changes needed.
// ---------------------------------------------------------------------------
const CMAC_MAPPING = {
  fields: {
    // Pickup → CMAC's `from` object. CONFIRMED via 400 validation response.
    // `address1` is CMAC's multi-line address slot (UK convention:
    //  Address1, Address2, City, Postcode — only Address1 is required).
    // Note: CMAC uses `lat`/`long` (short) not `latitude`/`longitude`.
    "pickup.lat":        { partner_field: "from.lat",      required: true },
    "pickup.lng":        { partner_field: "from.long",     required: true },
    "pickup.address":    { partner_field: "from.address1", required: true },

    // Dropoff → CMAC's `to` object. CONFIRMED via 400 validation response.
    "dropoff.lat":       { partner_field: "to.lat",      required: true },
    "dropoff.lng":       { partner_field: "to.long",     required: true },
    "dropoff.address":   { partner_field: "to.address1", required: true },

    // Passenger — CMAC's PascalCase-as-camelCase convention. CONFIRMED via
    // 400: leadPassengerName / leadPassengerPhone / numberOfPassengers.
    "passenger.name":    { partner_field: "leadPassengerName",   required: true },
    "passenger.phone":   { partner_field: "leadPassengerPhone",  required: true },
    "passenger.count":   { partner_field: "numberOfPassengers",  required: true },

    // Vehicle — CMAC's integer enum on `vehicleType` (CONFIRMED via
    // Swagger). Default is StandardCar (1) when omitted. Note: CMAC
    // labels 14 as "DdaCar" (Disability Discrimination Act car) — same
    // semantic as our canonical "wav".
    "vehicle_type": {
      partner_field: "vehicleType",
      value_lookup: {
        saloon: 1,           // StandardCar
        mpv: 5,              // Mpv
        people_carrier: 7,   // PeopleCarrier
        exec: 6,             // ExecutiveCar
        wav: 14,             // DdaCar
        black_cab: 99,       // BlackCab
      },
    },

    // Our internal booking id → CMAC's customerReference (CONFIRMED).
    "booking.id": { partner_field: "customerReference" },

    // Notes → CMAC accepts up to 1000 chars (CONFIRMED). Useful for
    // driver instructions like "ring buzzer 3, back gate".
    notes: { partner_field: "notes" },

    // `departs` — CMAC wants LOCAL `yyyy-MM-dd HH:mm` with NO timezone
    // marker (CONFIRMED via Swagger + the "too far in past" 400 we got
    // when omitting it on create). Our canonical scheduled_at is ISO
    // UTC; the format_datetime transform converts it to Europe/London
    // local time and renders it without a TZ suffix.
    "booking.scheduled_at": {
      partner_field: "departs",
      transform: { type: "format_datetime", format: "yyyy-MM-dd HH:mm", tz: "Europe/London" },
    },

    // RESPONSE-ONLY: CMAC pushes numeric job status IDs back to us.
    // Field name still assumed (`jobStatusId`) — first webhook from
    // CMAC will confirm.
    "booking.status": {
      partner_field: "jobStatusId",
      value_lookup_reverse: {
        "1":  "received",         // Created
        "2":  "accepted",         // Confirmed
        "9":  "driver_assigned",  // Assigned
        "3":  "en_route",         // Dispatched
        "8":  "driver_arrived",   // Arrived
        "4":  "on_board",         // On Board
        "5":  "completed",        // Completed
        "10": "no_match",         // No Job
      },
    },
  },
  endpoints: {
    create_booking: `${CMAC_BASE_URL}/Jobs`,
    quote: `${CMAC_BASE_URL}/JobsQuote`,
    // Cancel + Get use DELETE/GET + URL templating with the external id.
    cancel: {
      url: `${CMAC_BASE_URL}/Jobs/{external_id}`,
      method: "DELETE" as const,
    },
    get_booking: {
      url: `${CMAC_BASE_URL}/Jobs/{external_id}`,
      method: "GET" as const,
    },
    update_booking: {
      url: `${CMAC_BASE_URL}/Jobs/{external_id}`,
      method: "PUT" as const,
    },
  },
};

const CMAC_PARTNER_NAME = "CMAC Test";

async function upsertCmacPartner(): Promise<string> {
  const existing = await db
    .select()
    .from(partners)
    .where(eq(partners.name, CMAC_PARTNER_NAME))
    .limit(1);

  const encryptedCreds = encryptCredentials({
    authMechanism: "basic",
    username: CMAC_TEST_USERNAME,
    password: CMAC_TEST_PASSWORD,
  });

  // CMAC is a UK-national aggregator — centroid London, broad radius.
  const baseRow = {
    name: CMAC_PARTNER_NAME,
    legalName: "CMAC Group (Test Account)",
    kind: "external_aggregator" as const,
    adapterKey: "generic_mapped",
    status: "active" as const,
    participationMode: "send_and_receive" as const,
    applicationNotes:
      "Test partner for the H2 mapping engine (Epic 3). CMAC's API is " +
      "wired entirely via partners.fieldMappings — no CMAC-specific " +
      "TypeScript anywhere. Auth: HTTP Basic with the test-account " +
      "UUIDs CMAC issued via their developer portal. See " +
      "docs/CMAC_INTEGRATION.md for the assumed field names — first " +
      "live call will tell us what to rename in the UI.",
    centroidLat: 51.507,
    centroidLng: -0.128,
    serviceRadiusKm: 200, // CMAC is UK-national
    operatingRegions: ["United Kingdom"],
    vehicleTypes: ["standard", "exec", "mpv", "wav"],
    bookingTypes: ["asap", "prebook"] as ("asap" | "prebook")[],
    driverDetailsRequired: false,
    fieldMappings: CMAC_MAPPING as unknown as Record<string, unknown>,
    authMechanism: "basic" as const,
    credentials: encryptedCreds as unknown as Record<string, unknown>,
  };

  if (existing.length > 0) {
    await db
      .update(partners)
      .set({
        legalName: baseRow.legalName,
        kind: baseRow.kind,
        adapterKey: baseRow.adapterKey,
        applicationNotes: baseRow.applicationNotes,
        centroidLat: baseRow.centroidLat,
        centroidLng: baseRow.centroidLng,
        serviceRadiusKm: baseRow.serviceRadiusKm,
        operatingRegions: baseRow.operatingRegions,
        vehicleTypes: baseRow.vehicleTypes,
        bookingTypes: baseRow.bookingTypes,
        fieldMappings: baseRow.fieldMappings,
        authMechanism: baseRow.authMechanism,
        // Re-encrypt credentials on every run so rotating the source
        // constants in this file actually applies. Cost: re-encrypts
        // unchanged values, which is fine — GCM nonces are random per call.
        credentials: baseRow.credentials,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, existing[0].id));
    console.log(`[seed] updated  CMAC Test  (id=${existing[0].id.slice(0, 8)}…)`);
    return existing[0].id;
  }

  const [inserted] = await db.insert(partners).values(baseRow).returning();
  console.log(`[seed] created  CMAC Test  (id=${inserted.id.slice(0, 8)}…)`);
  return inserted.id;
}

async function upsertBilateralAllow(a: string, b: string) {
  for (const pair of [
    { o: a, r: b },
    { o: b, r: a },
  ]) {
    const existing = await db
      .select()
      .from(partnerRules)
      .where(
        and(
          eq(partnerRules.originatorId, pair.o),
          eq(partnerRules.recipientId, pair.r),
        ),
      );
    if (existing.length > 0) {
      if (existing[0].rule !== "allow") {
        await db
          .update(partnerRules)
          .set({ rule: "allow", updatedAt: new Date() })
          .where(
            and(
              eq(partnerRules.originatorId, pair.o),
              eq(partnerRules.recipientId, pair.r),
            ),
          );
      }
      continue;
    }
    await db.insert(partnerRules).values({
      originatorId: pair.o,
      recipientId: pair.r,
      rule: "allow",
    });
  }
}

async function ensureFeeConfig(recipientId: string) {
  const existing = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.recipientId, recipientId),
        eq(feeConfigs.scope, "partner"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(feeConfigs).values({
    scope: "partner",
    recipientId,
    sendFeePence: 20,
    receiveFeePence: 40,
    techFeePence: 0,
    techFeeBps: 0,
    bookingFeePence: 0,
    adminFeePence: 0,
    adminFeeBps: 0,
    createdBy: "seed:cmac-test",
  });
}

async function findPartnerIdByName(name: string): Promise<string | null> {
  const rows = await db
    .select({ id: partners.id })
    .from(partners)
    .where(eq(partners.name, name))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function main() {
  console.log("[seed] CMAC test partner");
  console.log(`[seed] base URL: ${CMAC_BASE_URL}`);
  console.log("[seed] this script is idempotent — re-running is safe\n");

  const cmacId = await upsertCmacPartner();

  // Tie CMAC into the existing iCabbi staging + FreeNow Dummy partners
  // if they're already seeded. If they're not present, just log it —
  // the operator can run `pnpm seed:icabbi-staging` first and re-run.
  const partnersToLink: Array<{ name: string }> = [
    { name: "iCabbi Staging COID 1102" },
    { name: "iCabbi Staging COID 2102" },
    { name: "FreeNow Dummy (test originator)" },
  ];

  console.log("");
  for (const p of partnersToLink) {
    const id = await findPartnerIdByName(p.name);
    if (!id) {
      console.log(`[seed] skip   bilateral allow with ${p.name}  (not seeded — run pnpm seed:icabbi-staging first)`);
      continue;
    }
    await upsertBilateralAllow(cmacId, id);
    console.log(`[seed] bilateral allow:  CMAC Test  ↔  ${p.name}`);
  }

  console.log("");
  await ensureFeeConfig(cmacId);
  console.log("[seed] fee config:  CMAC Test  (20p send / 40p receive)");

  console.log("\n[seed] done.\n");
  console.log("Next steps:");
  console.log("  1. Visit /partners and find CMAC Test.");
  console.log("  2. Inspect /partners/<cmac-id>/mappings — JSON should be the");
  console.log("     mapping config from this file.");
  console.log("  3. Hit POST /api/quote with a London-shaped booking to make");
  console.log("     the first live call. Watch logs for unknown-field warnings.");
  console.log("  4. Adjust assumed field names in the UI (no code change needed)");
  console.log("     and update docs/CMAC_INTEGRATION.md once confirmed.");

  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] FAILED", err);
  process.exit(1);
});
