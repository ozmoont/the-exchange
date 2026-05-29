/**
 * Seed two iCabbi fleets (Dublin Cabs, Cork Express) plus a CMAC corporate
 * partner. Set bilateral allow rules between all three. Configure standard
 * fees. After running this you can run the smoke test or open the portal.
 */

import { db } from "../db/client";
import {
  partners,
  partnerRules,
  feeConfigs,
  networkControls,
  transits,
  transitEvents,
  auditLog,
  webhookDeliveries,
  users,
} from "../db/schema";
import { encryptCredentials } from "../lib/crypto";
import { randomBytes } from "node:crypto";

async function main() {
  console.log("Seeding…");

  // Wipe in dependency order. Transits and events FK-reference partners;
  // users FK-references partners (partner_id, ON DELETE SET NULL — safe).
  await db.delete(transitEvents);
  await db.delete(transits);
  await db.delete(webhookDeliveries);
  await db.delete(partnerRules);
  await db.delete(feeConfigs);
  await db.delete(auditLog);
  await db.delete(users);
  await db.delete(partners);
  await db.delete(networkControls);
  console.log("  cleared previous data");

  // Pre-baked webhook secrets so `pnpm send-webhook` works against seeded
  // partners without going through the connect-via-UI flow. In production
  // (real iCabbi tenants) these come from the integration page on first
  // connect. They're encrypted at rest with PARTNER_CREDENTIAL_KEY.
  const dublinSecret = randomBytes(32).toString("base64url");
  const corkSecret = randomBytes(32).toString("base64url");
  const cmacSecret = randomBytes(32).toString("base64url");

  const [dublin, cork, cmac] = await db
    .insert(partners)
    .values([
      {
        kind: "icabbi_fleet",
        name: "Dublin Cabs",
        legalName: "Dublin Cabs Ltd",
        contactEmail: "ops@dublincabs.example",
        participationMode: "send_and_receive",
        status: "active",
        operatingRegions: ["IE-D"],
        vehicleTypes: ["standard", "exec"],
        bookingTypes: ["asap", "prebook"],
        adapterKey: "mock_icabbi",
        credentials: encryptCredentials({ tenantLabel: "dublin", webhookSecret: dublinSecret }) as unknown as Record<string, unknown>,
      },
      {
        kind: "icabbi_fleet",
        name: "Cork Express",
        legalName: "Cork Express Taxis Ltd",
        contactEmail: "ops@corkexpress.example",
        participationMode: "send_and_receive",
        status: "active",
        operatingRegions: ["IE-C"],
        vehicleTypes: ["standard"],
        bookingTypes: ["asap", "prebook"],
        adapterKey: "mock_icabbi",
        credentials: encryptCredentials({ tenantLabel: "cork", webhookSecret: corkSecret }) as unknown as Record<string, unknown>,
      },
      {
        kind: "external_corporate",
        name: "CMAC",
        legalName: "CMAC Group",
        contactEmail: "integrations@cmac.example",
        participationMode: "send_and_receive",
        status: "active",
        operatingRegions: ["GB", "IE"],
        vehicleTypes: ["standard", "exec"],
        bookingTypes: ["prebook"],
        adapterKey: "mock_cmac",
        credentials: encryptCredentials({ webhookSecret: cmacSecret }) as unknown as Record<string, unknown>,
      },
    ])
    .returning();

  console.log(`  partners: ${dublin.name}, ${cork.name}, ${cmac.name}`);

  // Mutual allow rules between all three
  const pairs: [string, string][] = [
    [dublin.id, cork.id],
    [cork.id, dublin.id],
    [dublin.id, cmac.id],
    [cmac.id, dublin.id],
    [cork.id, cmac.id],
    [cmac.id, cork.id],
  ];

  await db
    .insert(partnerRules)
    .values(pairs.map(([originatorId, recipientId]) => ({ originatorId, recipientId, rule: "allow" as const })));
  console.log(`  rules: ${pairs.length} allow rows`);

  // Fee config: recipient-level defaults
  await db.insert(feeConfigs).values([
    // iCabbi fleet defaults
    {
      scope: "partner",
      recipientId: dublin.id,
      sendFeePence: 15,
      receiveFeePence: 30,
      techFeePence: 0,
      techFeeBps: 0,
      bookingFeePence: 0,
      adminFeePence: 0,
      adminFeeBps: 0,
      createdBy: "seed",
    },
    {
      scope: "partner",
      recipientId: cork.id,
      sendFeePence: 15,
      receiveFeePence: 30,
      techFeePence: 0,
      techFeeBps: 0,
      bookingFeePence: 0,
      adminFeePence: 0,
      adminFeeBps: 0,
      createdBy: "seed",
    },
    // CMAC corporate booking — illustrates trip fee travelling with booking
    {
      scope: "partner",
      recipientId: cmac.id,
      sendFeePence: 20,
      receiveFeePence: 50,
      techFeePence: 100, // £1.00 tech fee
      techFeeBps: 0,
      bookingFeePence: 200, // £2.00 booking fee
      adminFeePence: 0,
      adminFeeBps: 300, // 3% admin fee
      createdBy: "seed",
    },
  ]);

  console.log("  fee configs: 3");

  await db.insert(networkControls).values({ id: "global", killSwitch: false });

  // Bootstrap a super admin from the first ALLOWED_EMAILS entry so the
  // signed-in dashboard works immediately after seeding. If no env value
  // is set, the bootstrap path in lib/auth.ts still triggers on first
  // login — but seeding the user here saves a round-trip.
  const adminEmail = String(process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)[0];

  if (adminEmail) {
    await db.insert(users).values({
      email: adminEmail,
      role: "super_admin",
      partnerId: null,
      invitedBy: "seed",
    });
    console.log(`  super admin: ${adminEmail}`);
  } else {
    console.log("  no ALLOWED_EMAILS env — first sign-in will bootstrap a super admin");
  }

  // Demo data — gives the dashboard, bookings list, audit log, and webhook
  // inspector something to show. Mix of statuses, timestamps, and origin/
  // recipient pairs. Don't run this against production — it inserts
  // fake transits, events, audit, and webhook deliveries.
  await seedDemoData({ dublin, cork, cmac });

  console.log("Done.");

  console.log("\nIds:");
  console.log(`  Dublin Cabs:  ${dublin.id}`);
  console.log(`  Cork Express: ${cork.id}`);
  console.log(`  CMAC:         ${cmac.id}`);
}

type SeedPartner = { id: string; name: string };

async function seedDemoData(opts: { dublin: SeedPartner; cork: SeedPartner; cmac: SeedPartner }) {
  const { dublin, cork, cmac } = opts;

  // Builders for compact transit insertion
  type LifecycleStage = "pushed" | "accepted" | "driver_assigned" | "en_route" | "on_board" | "completed" | "cancelled" | "no_match";
  type DemoTransit = {
    extId: string;
    originator: SeedPartner;
    recipient: SeedPartner | null;
    finalStatus: LifecycleStage;
    minutesAgo: number;
    fareEstimatePence?: number;
    bookingType?: "asap" | "prebook";
    pickup: string;
    dropoff: string;
  };

  const demoTransits: DemoTransit[] = [
    // Today — completed (~6)
    { extId: "DUB-D-1001", originator: dublin, recipient: cork, finalStatus: "completed", minutesAgo: 35, pickup: "O'Connell St, Dublin", dropoff: "Heuston Station" },
    { extId: "DUB-D-1002", originator: dublin, recipient: cork, finalStatus: "completed", minutesAgo: 95, fareEstimatePence: 2200, pickup: "Trinity College", dropoff: "Dublin Airport" },
    { extId: "COR-D-2001", originator: cork, recipient: dublin, finalStatus: "completed", minutesAgo: 140, pickup: "Patrick St, Cork", dropoff: "Kent Station" },
    { extId: "CMAC-D-3001", originator: cmac, recipient: dublin, finalStatus: "completed", minutesAgo: 200, fareEstimatePence: 4500, bookingType: "prebook", pickup: "The Shelbourne Hotel, Dublin", dropoff: "Dublin Airport T2" },
    { extId: "DUB-D-1003", originator: dublin, recipient: cmac, finalStatus: "completed", minutesAgo: 320, fareEstimatePence: 3800, bookingType: "prebook", pickup: "The Marker Hotel", dropoff: "Aviva Stadium" },
    { extId: "COR-D-2002", originator: cork, recipient: dublin, finalStatus: "completed", minutesAgo: 410, pickup: "UCC, Cork", dropoff: "Cork Airport" },

    // In flight (~3)
    { extId: "DUB-D-1010", originator: dublin, recipient: cork, finalStatus: "on_board", minutesAgo: 8, pickup: "Grafton St, Dublin", dropoff: "Sandymount" },
    { extId: "CMAC-D-3010", originator: cmac, recipient: dublin, finalStatus: "en_route", minutesAgo: 12, fareEstimatePence: 5200, bookingType: "prebook", pickup: "Conrad Hotel", dropoff: "Dublin Airport" },
    { extId: "DUB-D-1011", originator: dublin, recipient: cork, finalStatus: "driver_assigned", minutesAgo: 3, pickup: "Stephen's Green", dropoff: "Phoenix Park" },

    // Just pushed (~2)
    { extId: "COR-D-2010", originator: cork, recipient: dublin, finalStatus: "accepted", minutesAgo: 2, pickup: "St Patrick's St, Cork", dropoff: "Mahon Point" },
    { extId: "DUB-D-1020", originator: dublin, recipient: cmac, finalStatus: "pushed", minutesAgo: 1, fareEstimatePence: 6500, bookingType: "prebook", pickup: "Westbury Hotel", dropoff: "Cork Airport" },

    // Edge cases (~3)
    { extId: "DUB-D-1030", originator: dublin, recipient: cork, finalStatus: "cancelled", minutesAgo: 180, pickup: "Connolly Station", dropoff: "Dun Laoghaire" },
    { extId: "DUB-D-1031", originator: dublin, recipient: null, finalStatus: "no_match", minutesAgo: 260, pickup: "Pearse St", dropoff: "Howth" },

    // Yesterday (~2)
    { extId: "DUB-Y-1001", originator: dublin, recipient: cork, finalStatus: "completed", minutesAgo: 1640, pickup: "Temple Bar", dropoff: "Croke Park" },
    { extId: "CMAC-Y-3001", originator: cmac, recipient: dublin, finalStatus: "completed", minutesAgo: 1820, fareEstimatePence: 4100, bookingType: "prebook", pickup: "Marker Hotel", dropoff: "Dublin Airport T1" },
  ];

  // Lifecycle order — events to write for a given final status
  const lifecycleOrder: LifecycleStage[] = ["pushed", "accepted", "driver_assigned", "en_route", "on_board", "completed"];

  for (const dt of demoTransits) {
    const createdAt = new Date(Date.now() - dt.minutesAgo * 60_000);

    const feeSnapshot = dt.recipient
      ? {
          sendFeePence: dt.recipient.id === cmac.id ? 20 : 15,
          receiveFeePence: dt.recipient.id === cmac.id ? 50 : 30,
          techFeePence: dt.recipient.id === cmac.id ? 100 : 0,
          techFeeBps: 0,
          bookingFeePence: dt.recipient.id === cmac.id ? 200 : 0,
          adminFeePence: 0,
          adminFeeBps: dt.recipient.id === cmac.id ? 300 : 0,
          computedPassengerAddOnsPence:
            dt.recipient.id === cmac.id
              ? 100 + 200 + Math.round(((dt.fareEstimatePence ?? 0) * 300) / 10000)
              : 0,
          fareAtSnapshotPence: dt.fareEstimatePence ?? null,
          resolvedFromFeeConfigId: "seed",
        }
      : null;

    const [inserted] = await db
      .insert(transits)
      .values({
        originatorPartnerId: dt.originator.id,
        originatorBookingExternalId: dt.extId,
        recipientPartnerId: dt.recipient?.id ?? null,
        recipientBookingExternalId: dt.recipient ? `icabbi-${dt.recipient.name.toLowerCase().split(" ")[0]}-${dt.extId.slice(-4)}` : null,
        status: dt.finalStatus,
        bookingPayload: {
          originatorBookingExternalId: dt.extId,
          bookingType: dt.bookingType ?? "asap",
          channel: "app",
          pickup: { lat: 53.349, lng: -6.26, address: dt.pickup },
          dropoff: { lat: 53.421, lng: -6.27, address: dt.dropoff },
          scheduledFor: dt.bookingType === "prebook" ? new Date(createdAt.getTime() + 3600_000).toISOString() : undefined,
          vehicleType: dt.recipient?.id === cmac.id ? "executive" : "standard",
          passengerCount: 1,
          fareEstimatePence: dt.fareEstimatePence,
          passenger: { name: "Demo Passenger", phone: "+353 1 555 0000" },
          raw: { source: "seed" },
        },
        feeSnapshot,
        routingTrace: dt.recipient ? { consideredCount: 2, winner: dt.recipient.id } : { consideredCount: 0, reason: "no_eligible_partner" },
        createdAt,
        updatedAt: createdAt,
      })
      .returning();

    // Compose event timeline
    const events: { status: LifecycleStage | "received" | "routing"; offsetSeconds: number }[] = [
      { status: "received", offsetSeconds: 0 },
      { status: "routing", offsetSeconds: 2 },
    ];

    if (dt.finalStatus === "no_match") {
      events.push({ status: "no_match" as LifecycleStage, offsetSeconds: 5 });
    } else if (dt.finalStatus === "cancelled") {
      events.push({ status: "pushed", offsetSeconds: 5 });
      events.push({ status: "accepted", offsetSeconds: 30 });
      events.push({ status: "cancelled", offsetSeconds: 120 });
    } else {
      const idx = lifecycleOrder.indexOf(dt.finalStatus);
      // Walk from pushed through the final status, spacing each event a bit apart
      const stages = lifecycleOrder.slice(0, idx + 1);
      let offset = 5;
      for (const s of stages) {
        events.push({ status: s, offsetSeconds: offset });
        offset += 60 + Math.floor(Math.random() * 240); // 1-5 min between stages
      }
    }

    for (const ev of events) {
      await db.insert(transitEvents).values({
        transitId: inserted.id,
        status: ev.status as never,
        detail: { from: "seed" },
        actor: "system",
        createdAt: new Date(createdAt.getTime() + ev.offsetSeconds * 1000),
      });
    }
  }

  console.log(`  demo transits: ${demoTransits.length}`);

  // Seed a few audit log entries beyond the implicit ones
  await db.insert(auditLog).values([
    {
      category: "admin",
      actor: "admin_user",
      actorRef: "seed",
      action: "kill_switch.off",
      subjectType: "network",
      subjectId: "global",
      after: { killSwitch: false },
      createdAt: new Date(Date.now() - 60 * 60_000),
    },
    {
      category: "permission",
      actor: "admin_user",
      actorRef: "seed",
      action: "rule.allow",
      subjectType: "partner_rule",
      subjectId: `${dublin.id}->${cmac.id}`,
      after: { originatorId: dublin.id, recipientId: cmac.id, rule: "allow" },
      createdAt: new Date(Date.now() - 24 * 60 * 60_000),
    },
    {
      category: "fee",
      actor: "admin_user",
      actorRef: "seed",
      action: "fee.created",
      subjectType: "partner",
      subjectId: cmac.id,
      after: { recipientId: cmac.id, sendFeePence: 20, receiveFeePence: 50 },
      createdAt: new Date(Date.now() - 26 * 60 * 60_000),
    },
  ]);

  console.log("  audit entries: 3");

  // Seed a few webhook deliveries so the /webhooks inspector isn't empty
  await db.insert(webhookDeliveries).values([
    {
      source: `ingest:${dublin.id}`,
      sourceEventId: `seed-tripstatus-${Date.now() - 1000}`,
      payload: {
        id: `seed-evt-${Date.now() - 1000}`,
        event_type: "TripStatus",
        sent_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        data: JSON.stringify({ trip_id: "icabbi-cork-1001", status: "COMPLETED" }),
      },
      receivedAt: new Date(Date.now() - 5 * 60_000),
      outcome: "applied",
      processedAt: new Date(Date.now() - 5 * 60_000 + 200),
    },
    {
      source: `ingest:${dublin.id}`,
      sourceEventId: `seed-driverdetails-${Date.now() - 2000}`,
      payload: {
        id: `seed-evt-${Date.now() - 2000}`,
        event_type: "DriverDetails",
        sent_at: new Date(Date.now() - 12 * 60_000).toISOString(),
        data: JSON.stringify({
          trip_id: "icabbi-cork-1010",
          description: "Toyota Prius (Silver)",
          driver: { first_name: "John", last_name: "O'Brien", phone_number: "+353 1 000 0001" },
        }),
      },
      receivedAt: new Date(Date.now() - 12 * 60_000),
      outcome: "applied",
      processedAt: new Date(Date.now() - 12 * 60_000 + 150),
    },
    {
      source: `ingest:${cmac.id}`,
      sourceEventId: `seed-finalfare-${Date.now() - 3000}`,
      payload: {
        id: `seed-evt-${Date.now() - 3000}`,
        event_type: "FinalFareReleased",
        sent_at: new Date(Date.now() - 200 * 60_000).toISOString(),
        data: JSON.stringify({ trip_id: "icabbi-dublin-3001" }),
      },
      receivedAt: new Date(Date.now() - 200 * 60_000),
      outcome: "ack_unhandled",
      processedAt: new Date(Date.now() - 200 * 60_000 + 100),
    },
  ]);

  console.log("  webhook deliveries: 3");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
