/**
 * Smoke-test the CMAC integration end-to-end against their test API.
 *
 * Adapter-direct (bypasses the routing engine) so the signal is clean —
 * we see exactly what bytes go on the wire and what CMAC sends back.
 *
 * Phases:
 *   1. Look up the CMAC partner row + decrypt credentials.
 *   2. Build a sample London booking in canonical shape; print the
 *      mapped JSON we'd send (no HTTP yet).
 *   3. Call quote() — POST /JobsQuote. Print response.
 *   4. (Opt-in via --create flag) call createBooking() — POST /Jobs.
 *      Print the returned external id. Then cancelBooking() — DELETE
 *      /Jobs/{id} — to clean up.
 *
 * Prereqs:
 *   - DATABASE_URL pointing at the DB where CMAC was seeded
 *   - PARTNER_CREDENTIAL_KEY set (to decrypt credentials)
 *   - The partner row exists — run `pnpm seed:cmac-test` first
 *
 * Usage:
 *   pnpm smoke:cmac                # quote only (no booking created)
 *   pnpm smoke:cmac -- --create    # quote + create + cancel
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { partners } from "../db/schema";
import { decryptIfNeeded } from "../lib/crypto";
import { GenericMappedAdapter } from "../adapters/generic-mapped";
import { applyMapping, loadMappingConfig } from "../lib/mapping-layer";
import type { NormalisedBooking } from "../lib/types";

const CMAC_PARTNER_NAME = "CMAC Test";

// ---------------------------------------------------------------------------
// Sample booking — a London Heathrow → Soho run. Chosen to exercise:
//   - lat/lng (-0.45 and -0.13)
//   - vehicle_type → numeric enum lookup
//   - prebook (scheduled_at) field
//   - fare estimate (pence → major-unit transform via .100 in adapter)
// ---------------------------------------------------------------------------
function sampleBooking(): NormalisedBooking {
  const now = new Date();
  const pickupAt = new Date(now.getTime() + 60 * 60_000).toISOString(); // +1h
  return {
    originatorBookingExternalId: `smoke-cmac-${Date.now()}`,
    bookingType: "prebook",
    channel: "api",
    pickup: {
      lat: 51.4700,
      lng: -0.4543,
      address: "Heathrow Airport, Terminal 5, Hounslow TW6",
      postcode: "TW6 2GA",
    },
    dropoff: {
      lat: 51.5142,
      lng: -0.1380,
      address: "Soho Square, London W1D",
      postcode: "W1D 3AT",
    },
    scheduledFor: pickupAt,
    vehicleType: "saloon", // → 1 (Taxi) via CMAC's vehicle lookup
    passengerCount: 2,
    fareEstimatePence: 5500, // £55.00 — printed by mapping engine as 55
    passenger: {
      name: "Smoke Test",
      // CMAC schema is explicit: "no spaces, plus sign or leading zero,
      // but prefixed by country code". So 447... not +447... The validator
      // only enforces length 11-15 but the quote engine downstream parses
      // this as a phone object and 500s on the `+`.
      phone: "447700900123",
    },
    // ASCII-only — keeping it clean in case CMAC's stack isn't UTF-8 safe
    // throughout. Em-dashes in payloads are a low-rate but real cause of
    // 500s in legacy .NET pipelines.
    notes: "Smoke test from the Exchange - adapter-direct CMAC verification",
    raw: { source: "smoke-cmac.ts" },
  };
}

// ---------------------------------------------------------------------------
// Tiny logging helpers
// ---------------------------------------------------------------------------

const HR = "─".repeat(72);

function section(title: string) {
  console.log("\n" + HR);
  console.log(`  ${title}`);
  console.log(HR);
}

function dump(label: string, value: unknown) {
  console.log(`\n${label}:`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function loadCmacPartner() {
  const rows = await db
    .select()
    .from(partners)
    .where(eq(partners.name, CMAC_PARTNER_NAME))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      `Partner "${CMAC_PARTNER_NAME}" not found. Run \`pnpm seed:cmac-test\` first.`,
    );
  }
  const row = rows[0];
  const creds = decryptIfNeeded(
    row.credentials as Record<string, unknown> | null | undefined,
  );
  if (!creds) {
    throw new Error("CMAC partner has no credentials — seed must have failed.");
  }
  if (!row.fieldMappings) {
    throw new Error("CMAC partner has no fieldMappings — seed must have failed.");
  }
  return { id: row.id, creds, fieldMappings: row.fieldMappings };
}

function previewMapping(
  fieldMappings: Record<string, unknown> | null,
  partnerId: string,
  booking: NormalisedBooking,
) {
  // Mirror what the adapter does internally so we can inspect the bytes
  // before any HTTP call.
  const canonical: Record<string, unknown> = {
    pickup: { ...booking.pickup },
    dropoff: { ...booking.dropoff },
    vehicle_type: booking.vehicleType,
    passenger: {
      name: booking.passenger.name,
      phone: booking.passenger.phone,
      count: booking.passengerCount,
    },
    booking: {
      id: booking.originatorBookingExternalId,
      type: booking.bookingType === "prebook" ? "PREBOOK" : "ASAP",
      ...(booking.scheduledFor ? { scheduled_at: booking.scheduledFor } : {}),
    },
    ...(booking.fareEstimatePence != null
      ? { fare: { amount: booking.fareEstimatePence / 100, currency: "GBP" } }
      : {}),
    ...(booking.notes ? { notes: booking.notes } : {}),
  };

  const cfg = loadMappingConfig(partnerId, fieldMappings);
  if (!cfg) {
    throw new Error("loadMappingConfig returned null — invalid config shape");
  }

  const mapped = applyMapping(canonical, cfg);
  dump("Canonical (what we have internally)", canonical);
  if (mapped.ok) {
    dump("Mapped (what we send to CMAC)", mapped.payload);
    if (mapped.warnings.length > 0) {
      dump("Mapping warnings", mapped.warnings);
    }
  } else {
    dump("Mapping FAILED — missing required fields", mapped.missing);
    process.exit(1);
  }
}

async function main() {
  const wantCreate = process.argv.includes("--create");

  section("Phase 1: load CMAC partner row");
  const { id, creds, fieldMappings } = await loadCmacPartner();
  console.log(`  partner.id      ${id}`);
  console.log(`  authMechanism   ${(creds as { authMechanism?: string }).authMechanism}`);
  console.log(`  username        ${(creds as { username?: string }).username?.slice(0, 8)}…  (UUID, masked)`);

  section("Phase 2: build sample booking + preview mapping");
  const booking = sampleBooking();
  previewMapping(fieldMappings as Record<string, unknown> | null, id, booking);

  const adapter = new GenericMappedAdapter(id, creds as never, fieldMappings);

  section("Phase 3: POST /JobsQuote");
  try {
    const quote = await adapter.quote({ booking });
    dump("Quote response (canonical)", quote);
    if (!quote.available) {
      console.log(
        "\n  Quote says not available. Could be a real 'no driver' response, " +
          "or it could be that the field names in our mapping config don't " +
          "match what CMAC's API expects. Check the reason and the request " +
          "logs above.",
      );
    }
  } catch (err) {
    console.error("\n  Quote threw:", err instanceof Error ? err.message : err);
  }

  if (!wantCreate) {
    console.log("\n  (skipping create+cancel — re-run with `--create` to test those endpoints)");
    process.exit(0);
  }

  section("Phase 4: POST /Jobs (create booking)");
  let externalId: string | null = null;
  try {
    const result = await adapter.createBooking({
      transitId: "smoke-cmac-transit",
      recipientPartnerId: id,
      booking,
      feeSnapshot: {
        sendFeePence: 20,
        receiveFeePence: 40,
        techFeePence: 0,
        techFeeBps: 0,
        bookingFeePence: 0,
        adminFeePence: 0,
        adminFeeBps: 0,
        computedPassengerAddOnsPence: 0,
        fareAtSnapshotPence: booking.fareEstimatePence ?? null,
        resolvedFromFeeConfigId: "smoke-cmac",
      },
    });
    dump("Create response (canonical)", result);
    externalId = result.externalId;
  } catch (err) {
    console.error("\n  Create threw:", err instanceof Error ? err.message : err);
  }

  if (externalId) {
    section(`Phase 5: DELETE /Jobs/${externalId} (cancel cleanup)`);
    try {
      await adapter.cancelBooking({ externalId, reason: "smoke-test cleanup" });
      console.log("  Cancel completed (no body returned by CMAC on 202)");
    } catch (err) {
      console.error("  Cancel threw:", err instanceof Error ? err.message : err);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[smoke] FAILED", err);
  process.exit(1);
});
