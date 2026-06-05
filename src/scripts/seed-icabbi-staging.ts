/**
 * Seed the iCabbi staging test setup.
 *
 * Creates three partner rows so we can run a real end-to-end booking flow:
 *
 *   1. FreeNow Dummy (kind=external_aggregator) — the originator.
 *      No real FreeNow API key. We use this partner as the source of a
 *      synthesised booking that flows into the Exchange.
 *
 *   2. iCabbi Staging — COID 1102 (kind=icabbi_fleet) — recipient #1.
 *      Real staging tenant. App-Key/Secret-Key pasted via the UI after
 *      this seed runs (so they get AES-256-GCM encrypted at rest).
 *
 *   3. iCabbi Staging — COID 2102 (kind=icabbi_fleet) — recipient #2.
 *      Real staging tenant. Same flow.
 *
 * Bilateral allow rules are created between every pair so routing can
 * waterfall: FreeNow → 1102 → fallback 2102, etc. Per-pair fee configs
 * are seeded with sensible defaults (20p send, 40p receive).
 *
 * Idempotent: re-running won't duplicate rows. Existing partners are
 * looked up by name and updated in-place; rules are upserted by primary
 * key (originator_id, recipient_id).
 *
 * After running this script:
 *   - Visit /partners/<id>/integration for each iCabbi tenant
 *   - Paste App-Key + Secret-Key + the staging API URL
 *   - Click Connect — credentials get encrypted and webhook auto-registers
 *
 * Usage:
 *   pnpm seed:icabbi-staging
 */

import { db } from "../db/client";
import { partners, partnerRules, feeConfigs } from "../db/schema";
import { and, eq } from "drizzle-orm";

const STAGING_API_URL = "https://1stagingapi.icabbi.com/1staging";

type SeedPartner = {
  name: string;
  legalName: string;
  kind: "external_aggregator" | "icabbi_fleet";
  adapterKey: string;
  applicationNotes: string;
  centroidLat: number;
  centroidLng: number;
  serviceRadiusKm: number;
  operatingRegions: string[];
};

// Centroids chosen to give the routing engine geographic spread. The
// iCabbi staging tenants don't have a real geography — we pick London +
// Manchester so the candidates look distinct on the map.
const SEED_PARTNERS: SeedPartner[] = [
  {
    name: "FreeNow Dummy (test originator)",
    legalName: "FreeNow Dummy Ltd",
    kind: "external_aggregator",
    adapterKey: "mock_freenow",
    applicationNotes:
      "Test originator for the iCabbi staging round-trip. Synthesised " +
      "bookings flow from here into the Exchange and route to the two " +
      "iCabbi staging tenants. No real FreeNow API key required.",
    // London — central
    centroidLat: 51.507,
    centroidLng: -0.128,
    serviceRadiusKm: 60,
    operatingRegions: ["London", "Greater London"],
  },
  {
    name: "iCabbi Staging COID 1102",
    legalName: "iCabbi Staging Tenant 1102",
    kind: "icabbi_fleet",
    adapterKey: "mock_icabbi", // flips to 'icabbi' when credentials are pasted via /integration
    applicationNotes:
      "Real iCabbi staging tenant. COID 1102. Test drivers 147, 1889, " +
      "5200. API URL: " + STAGING_API_URL + ". After this seed runs, " +
      "visit /partners/<id>/integration and paste the App-Key + " +
      "Secret-Key from the iCabbi secureshare link, plus the staging " +
      "API URL above. Driver app simulator can be used to simulate " +
      "driver-side actions for end-to-end testing.",
    centroidLat: 51.507,
    centroidLng: -0.128,
    serviceRadiusKm: 30,
    operatingRegions: ["London"],
  },
  {
    name: "iCabbi Staging COID 2102",
    legalName: "iCabbi Staging Tenant 2102",
    kind: "icabbi_fleet",
    adapterKey: "mock_icabbi",
    applicationNotes:
      "Real iCabbi staging tenant. COID 2102. Test driver 999. " +
      "API URL: " + STAGING_API_URL + ". After this seed runs, visit " +
      "/partners/<id>/integration and paste the App-Key + Secret-Key " +
      "from the iCabbi secureshare link, plus the staging API URL above.",
    centroidLat: 53.481,
    centroidLng: -2.244,
    serviceRadiusKm: 30,
    operatingRegions: ["Manchester", "Greater Manchester"],
  },
];

async function upsertPartner(p: SeedPartner): Promise<string> {
  const existing = await db
    .select()
    .from(partners)
    .where(eq(partners.name, p.name))
    .limit(1);

  if (existing.length > 0) {
    // Update in place. Don't touch status (might be 'active' from a prior
    // connect) and don't touch credentials (would clobber a paste).
    await db
      .update(partners)
      .set({
        legalName: p.legalName,
        kind: p.kind,
        adapterKey: existing[0].adapterKey === "icabbi" ? "icabbi" : p.adapterKey,
        applicationNotes: p.applicationNotes,
        centroidLat: p.centroidLat,
        centroidLng: p.centroidLng,
        serviceRadiusKm: p.serviceRadiusKm,
        operatingRegions: p.operatingRegions,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, existing[0].id));
    console.log(`[seed] updated  ${p.name}  (id=${existing[0].id.slice(0, 8)}…)`);
    return existing[0].id;
  }

  const [inserted] = await db
    .insert(partners)
    .values({
      name: p.name,
      legalName: p.legalName,
      kind: p.kind,
      adapterKey: p.adapterKey,
      // Active immediately so routing considers them. The credentials
      // missing means the iCabbi adapter calls would fail at runtime, but
      // the seed itself doesn't trigger those calls. OG fills in
      // credentials via /integration before we run the smoke.
      status: "active",
      participationMode: "send_and_receive",
      applicationNotes: p.applicationNotes,
      centroidLat: p.centroidLat,
      centroidLng: p.centroidLng,
      serviceRadiusKm: p.serviceRadiusKm,
      operatingRegions: p.operatingRegions,
      vehicleTypes: ["standard", "exec"],
      bookingTypes: ["asap", "prebook"],
      driverDetailsRequired: false,
    })
    .returning();
  console.log(`[seed] created  ${p.name}  (id=${inserted.id.slice(0, 8)}…)`);
  return inserted.id;
}

async function upsertBilateralAllow(originatorId: string, recipientId: string) {
  // Both directions — upsert each.
  for (const pair of [
    { o: originatorId, r: recipientId },
    { o: recipientId, r: originatorId },
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
    createdBy: "seed:icabbi-staging",
  });
}

async function main() {
  console.log("[seed] iCabbi staging test setup");
  console.log(`[seed] staging API URL: ${STAGING_API_URL}`);
  console.log("[seed] this script is idempotent — re-running is safe\n");

  // 1. Upsert the three partners
  const ids: string[] = [];
  for (const p of SEED_PARTNERS) {
    const id = await upsertPartner(p);
    ids.push(id);
  }

  // 2. Mutual allow rules across every pair (3 partners = 3 pairs)
  console.log("");
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      await upsertBilateralAllow(ids[i], ids[j]);
      console.log(
        `[seed] bilateral allow: ${SEED_PARTNERS[i].name.slice(0, 30)}  ↔  ${SEED_PARTNERS[j].name.slice(0, 30)}`,
      );
    }
  }

  // 3. Default fee config for each recipient
  console.log("");
  for (let i = 0; i < ids.length; i++) {
    await ensureFeeConfig(ids[i]);
    console.log(`[seed] fee config: ${SEED_PARTNERS[i].name} (20p send / 40p receive)`);
  }

  console.log("\n[seed] done.\n");
  console.log("Next steps:");
  console.log("  1. Visit /partners and find the two iCabbi Staging entries.");
  console.log("  2. For each: open Integration tab, paste App-Key + Secret-Key,");
  console.log(`     and set API URL to:  ${STAGING_API_URL}`);
  console.log("  3. Click Connect. Webhook auto-registers with iCabbi.");
  console.log("  4. Run the smoke:");
  console.log("        pnpm smoke:icabbi-staging");

  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] FAILED", err);
  process.exit(1);
});
