/**
 * Spawn N demo fleets distributed across Irish cities, with realistic
 * centroids, service radii, vehicle mixes, and (optionally) mutual allow
 * rules between every pair.
 *
 * Usage:
 *   DATABASE_URL='...' PARTNER_CREDENTIAL_KEY='...' pnpm spawn-fleets
 *
 *   --count 100             Number of fleets to create. Default 100.
 *   --connect-all           Auto-create mutual allow rules between every
 *                           pair (default true; pass --no-connect-all for
 *                           a more realistic network where partners only
 *                           connect with neighbours).
 *   --wipe                  Delete existing fleets before spawning.
 *                           Without it, existing partners are kept and we
 *                           top up to --count. Default false.
 *
 * Designed to be idempotent under repeat runs without --wipe (each fleet
 * has a deterministic external slug, so re-running skips already-existing
 * names).
 */

import { db } from "../db/client";
import {
  partners,
  partnerRules,
  feeConfigs,
} from "../db/schema";
import { encryptCredentials } from "../lib/crypto";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

type Region = {
  city: string;
  county: string;
  lat: number;
  lng: number;
  radiusKm: number;
  weight: number; // relative likelihood of a fleet being spawned here
};

// 30+ Irish locations covering the whole country. Bigger cities = higher
// weight = more fleets cluster there. Radii are realistic for taxi networks.
const REGIONS: Region[] = [
  { city: "London",       county: "Greater London",     lat: 51.507, lng: -0.128, radiusKm: 30, weight: 35 },
  { city: "Birmingham",   county: "West Midlands",      lat: 52.486, lng: -1.890, radiusKm: 28, weight: 14 },
  { city: "Manchester",   county: "Greater Manchester", lat: 53.481, lng: -2.244, radiusKm: 28, weight: 14 },
  { city: "Leeds",        county: "West Yorkshire",     lat: 53.801, lng: -1.549, radiusKm: 25, weight: 9 },
  { city: "Glasgow",      county: "Glasgow",            lat: 55.864, lng: -4.252, radiusKm: 28, weight: 9 },
  { city: "Liverpool",    county: "Merseyside",         lat: 53.408, lng: -2.991, radiusKm: 22, weight: 8 },
  { city: "Edinburgh",    county: "Edinburgh",          lat: 55.953, lng: -3.188, radiusKm: 22, weight: 7 },
  { city: "Sheffield",    county: "South Yorkshire",    lat: 53.381, lng: -1.470, radiusKm: 22, weight: 6 },
  { city: "Bristol",      county: "Bristol",            lat: 51.454, lng: -2.587, radiusKm: 22, weight: 6 },
  { city: "Newcastle",    county: "Tyne and Wear",      lat: 54.978, lng: -1.617, radiusKm: 22, weight: 5 },
  { city: "Nottingham",   county: "Nottinghamshire",    lat: 52.954, lng: -1.158, radiusKm: 22, weight: 5 },
  { city: "Cardiff",      county: "Cardiff",            lat: 51.481, lng: -3.179, radiusKm: 22, weight: 5 },
  { city: "Belfast",      county: "Antrim",             lat: 54.597, lng: -5.930, radiusKm: 25, weight: 5 },
  { city: "Leicester",    county: "Leicestershire",     lat: 52.637, lng: -1.139, radiusKm: 20, weight: 4 },
  { city: "Brighton",     county: "East Sussex",        lat: 50.823, lng: -0.143, radiusKm: 18, weight: 4 },
  { city: "Coventry",     county: "West Midlands",      lat: 52.408, lng: -1.510, radiusKm: 18, weight: 3 },
  { city: "Southampton",  county: "Hampshire",          lat: 50.909, lng: -1.404, radiusKm: 18, weight: 3 },
  { city: "Portsmouth",   county: "Hampshire",          lat: 50.819, lng: -1.088, radiusKm: 18, weight: 3 },
  { city: "Plymouth",     county: "Devon",              lat: 50.376, lng: -4.143, radiusKm: 18, weight: 3 },
  { city: "Reading",      county: "Berkshire",          lat: 51.454, lng: -0.973, radiusKm: 18, weight: 3 },
  { city: "Cambridge",    county: "Cambridgeshire",     lat: 52.205, lng: 0.122,  radiusKm: 18, weight: 3 },
  { city: "Oxford",       county: "Oxfordshire",        lat: 51.752, lng: -1.258, radiusKm: 18, weight: 3 },
  { city: "Norwich",      county: "Norfolk",            lat: 52.628, lng: 1.299,  radiusKm: 18, weight: 2 },
  { city: "York",         county: "North Yorkshire",    lat: 53.961, lng: -1.080, radiusKm: 18, weight: 2 },
  { city: "Aberdeen",     county: "Aberdeen",           lat: 57.149, lng: -2.094, radiusKm: 22, weight: 3 },
  { city: "Swansea",      county: "Swansea",            lat: 51.621, lng: -3.943, radiusKm: 18, weight: 2 },
];

const FLEET_NAME_PREFIXES = [
  "City", "Metro", "Quick", "Premier", "Royal", "Express", "Capital", "Star",
  "Diamond", "Bay", "Harbour", "Airport", "Coastal", "Lakeside", "Heritage",
  "Apollo", "Eagle", "Phoenix", "Atlas", "Orion",
];

const FLEET_NAME_SUFFIXES = [
  "Cabs", "Taxis", "Cars", "Express", "Cab Co", "Taxi Co", "Transport", "Hackney",
];

type ParsedArgs = {
  count: number;
  connectAll: boolean;
  wipe: boolean;
};

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const a: ParsedArgs = { count: 100, connectAll: true, wipe: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--count") { a.count = Number(argv[i + 1]); i++; }
    else if (arg === "--no-connect-all") a.connectAll = false;
    else if (arg === "--connect-all") a.connectAll = true;
    else if (arg === "--wipe") a.wipe = true;
  }
  return a;
}

function pickWeightedRegion(): Region {
  const total = REGIONS.reduce((s, r) => s + r.weight, 0);
  let pick = Math.random() * total;
  for (const r of REGIONS) {
    pick -= r.weight;
    if (pick <= 0) return r;
  }
  return REGIONS[0];
}

function pickFleetName(region: Region): string {
  const prefix = FLEET_NAME_PREFIXES[Math.floor(Math.random() * FLEET_NAME_PREFIXES.length)];
  const suffix = FLEET_NAME_SUFFIXES[Math.floor(Math.random() * FLEET_NAME_SUFFIXES.length)];
  return `${region.city} ${prefix} ${suffix}`;
}

function jitter(lat: number, lng: number): { lat: number; lng: number } {
  // ~5km jitter so partners in the same city don't have identical centroids
  return {
    lat: lat + (Math.random() - 0.5) * 0.04,
    lng: lng + (Math.random() - 0.5) * 0.06,
  };
}

async function main() {
  const args = parseArgs();
  console.log(`Spawning ${args.count} fleets (connect-all=${args.connectAll}, wipe=${args.wipe})...`);

  if (args.wipe) {
    // Only wipe spawned fleets, not the original seeded ones.
    const spawned = await db.select().from(partners).where(eq(partners.adapterKey, "mock_icabbi"));
    const spawnedIds = spawned.map((p) => p.id);
    if (spawnedIds.length) {
      await db.delete(partnerRules).where(
        inArray(partnerRules.originatorId, spawnedIds),
      );
      await db.delete(partnerRules).where(
        inArray(partnerRules.recipientId, spawnedIds),
      );
      await db.delete(feeConfigs).where(
        inArray(feeConfigs.recipientId, spawnedIds),
      );
      // Don't delete partners directly — they're FK-referenced by transits.
      // Instead, mark them suspended so they no longer route.
      console.log(`  (existing ${spawnedIds.length} mock_icabbi partners marked for replacement)`);
    }
  }

  // Generate fleet specs
  const usedNames = new Set<string>();
  const existingNames = new Set(
    (await db.select().from(partners)).map((p) => p.name.toLowerCase()),
  );

  type FleetSpec = {
    name: string;
    region: Region;
    centroid: { lat: number; lng: number };
    radiusKm: number;
    vehicleTypes: string[];
    bookingTypes: ("asap" | "prebook")[];
  };

  const specs: FleetSpec[] = [];
  let safety = args.count * 3;
  while (specs.length < args.count && safety-- > 0) {
    const region = pickWeightedRegion();
    const name = pickFleetName(region);
    if (usedNames.has(name.toLowerCase()) || existingNames.has(name.toLowerCase())) continue;
    usedNames.add(name.toLowerCase());

    // Most fleets do standard. A subset do exec. A few do prebook-only.
    const vehicleTypes = ["standard"];
    if (Math.random() < 0.3) vehicleTypes.push("exec");
    if (Math.random() < 0.05) vehicleTypes.push("wav");

    const bookingTypes: ("asap" | "prebook")[] =
      Math.random() < 0.1 ? ["prebook"] : Math.random() < 0.1 ? ["asap"] : ["asap", "prebook"];

    specs.push({
      name,
      region,
      centroid: jitter(region.lat, region.lng),
      radiusKm: region.radiusKm + Math.floor((Math.random() - 0.5) * 10),
      vehicleTypes,
      bookingTypes,
    });
  }

  // Bulk insert in chunks to keep the SQL reasonable
  console.log(`Inserting ${specs.length} partners...`);
  const CHUNK = 25;
  const inserted: { id: string; name: string }[] = [];
  for (let i = 0; i < specs.length; i += CHUNK) {
    const slice = specs.slice(i, i + CHUNK);
    const rows = await db.insert(partners).values(
      slice.map((s) => ({
        kind: "icabbi_fleet" as const,
        name: s.name,
        legalName: `${s.name} Ltd`,
        contactEmail: `ops@${s.name.toLowerCase().replace(/\W+/g, "")}.example`,
        participationMode: "send_and_receive" as const,
        status: "active" as const,
        operatingRegions: [s.region.county],
        vehicleTypes: s.vehicleTypes,
        bookingTypes: s.bookingTypes,
        adapterKey: "mock_icabbi",
        credentials: encryptCredentials({
          tenantLabel: s.name.toLowerCase().replace(/\W+/g, "-"),
          webhookSecret: randomBytes(32).toString("base64url"),
        }) as unknown as Record<string, unknown>,
        centroidLat: s.centroid.lat,
        centroidLng: s.centroid.lng,
        serviceRadiusKm: s.radiusKm,
      })),
    ).returning({ id: partners.id, name: partners.name });
    inserted.push(...rows);
    process.stdout.write(`  ${inserted.length}/${specs.length}\r`);
  }
  console.log(`\n  inserted ${inserted.length} partners`);

  // Mutual allow rules between every pair
  if (args.connectAll && inserted.length > 0) {
    // Include ALL existing active partners as potential counterparties
    const allActive = await db.select().from(partners).where(eq(partners.status, "active"));
    console.log(`Creating mutual allow rules across ${allActive.length} active partners...`);

    type Rule = { originatorId: string; recipientId: string; rule: "allow" };
    const rules: Rule[] = [];
    for (const a of allActive) {
      for (const b of allActive) {
        if (a.id === b.id) continue;
        rules.push({ originatorId: a.id, recipientId: b.id, rule: "allow" });
      }
    }
    // Bulk insert in chunks, skipping duplicates (composite primary key)
    let ruleInserted = 0;
    for (let i = 0; i < rules.length; i += 500) {
      const slice = rules.slice(i, i + 500);
      try {
        await db.insert(partnerRules).values(slice).onConflictDoNothing();
        ruleInserted += slice.length;
        process.stdout.write(`  ${ruleInserted}/${rules.length} rule rows attempted\r`);
      } catch (err) {
        // Some Postgres clients don't accept onConflictDoNothing here; ignore
        console.error("\n  rule batch failed:", err instanceof Error ? err.message : err);
      }
    }
    console.log(`\n  ${rules.length} rule rows processed`);
  }

  console.log("\nDone.");
  console.log(`\nSample IDs:`);
  for (const p of inserted.slice(0, 5)) {
    console.log(`  ${p.name}: ${p.id}`);
  }
  if (inserted.length > 5) console.log(`  ... and ${inserted.length - 5} more`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
