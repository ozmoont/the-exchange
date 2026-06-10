import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter registry (src/adapters/registry.ts): the switch that turns a
 * partners.adapterKey row into a live adapter. A wrong selection routes real
 * bookings through the wrong integration, so every factory branch is locked
 * in — mock_* → dev adapters, icabbi → real (needs creds), generic_mapped →
 * H2 config-driven, unknown key/partner → loud errors. DB mocked via a
 * controller; decryptIfNeeded is a recorded passthrough to prove creds are
 * decrypted before use.
 */

// Controls the mocked db.select() chain result + counts calls so the caching
// tests can prove the DB is hit once per partner.
const dbController: {
  rows: Array<Record<string, unknown>>;
  selectCalls: number;
} = { rows: [], selectCalls: 0 };

vi.mock("@/db/client", () => ({
  db: {
    select: () => {
      dbController.selectCalls += 1;
      // drizzle chain: .from(...).where(...) → rows.
      const chain = {
        from: () => chain,
        where: async () => dbController.rows,
      };
      return chain;
    },
  },
}));

// Passthrough decrypt — registry must call it on every credentials read; the
// spy lets us assert that.
vi.mock("@/lib/crypto", () => ({
  decryptIfNeeded: vi.fn((x: Record<string, unknown> | null) => x),
}));

import { getAdapterForPartner, clearAdapterCache } from "@/adapters/registry";
import { MockICabbiAdapter } from "@/adapters/mock-icabbi";
import { MockCMACAdapter } from "@/adapters/mock-cmac";
import { MockFreeNowAdapter } from "@/adapters/mock-freenow";
import { ICabbiAdapter } from "@/adapters/icabbi";
import { GenericMappedAdapter } from "@/adapters/generic-mapped";
import { decryptIfNeeded } from "@/lib/crypto";

/** Build a partners row with sensible defaults; tests override what matters. */
function partnerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p-1",
    adapterKey: "mock_icabbi",
    credentials: null,
    fieldMappings: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Registry caches at module level — clear so each test starts fresh.
  clearAdapterCache();
  dbController.rows = [];
  dbController.selectCalls = 0;
  vi.mocked(decryptIfNeeded).mockClear();
});

describe("getAdapterForPartner — error paths", () => {
  it("throws a clear error when the partner row doesn't exist", async () => {
    // Empty result → identifiable failure, not an undefined-property crash.
    dbController.rows = [];
    await expect(getAdapterForPartner("ghost-partner")).rejects.toThrow(
      "Partner ghost-partner not found",
    );
  });

  it("throws when the row carries an adapterKey nobody registered", async () => {
    // A typo'd adapterKey must fail loudly, naming the bad key.
    dbController.rows = [partnerRow({ id: "p-bad", adapterKey: "fax_machine" })];
    await expect(getAdapterForPartner("p-bad")).rejects.toThrow(
      'No adapter registered for key "fax_machine"',
    );
  });

  it("throws when adapterKey is 'icabbi' but no credentials are saved", async () => {
    // Real adapter is useless without creds — refuse to construct rather than
    // fail on the first live call.
    dbController.rows = [partnerRow({ id: "p-ic", adapterKey: "icabbi", credentials: null })];
    await expect(getAdapterForPartner("p-ic")).rejects.toThrow(/no credentials saved/);
  });
});

describe("getAdapterForPartner — factory selection", () => {
  it("builds a MockICabbiAdapter for adapterKey mock_icabbi using creds.tenantLabel", async () => {
    // tenantLabel is private but observable via the mock's deterministic
    // externalId — that proves it was wired in.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbController.rows = [
      partnerRow({ id: "p-mi", adapterKey: "mock_icabbi", credentials: { tenantLabel: "tenA" } }),
    ];

    const adapter = await getAdapterForPartner("p-mi");
    expect(adapter).toBeInstanceOf(MockICabbiAdapter);
    expect(adapter.key).toBe("mock_icabbi");
    expect(adapter.partnerId).toBe("p-mi");

    const r = await adapter.createBooking({
      transitId: "abcdef12-0000-0000-0000-000000000000",
      recipientPartnerId: "p-x",
      booking: {
        originatorBookingExternalId: "O-1",
        bookingType: "asap",
        channel: "app",
        pickup: { lat: 0, lng: 0, address: "A" },
        dropoff: { lat: 1, lng: 1, address: "B" },
        vehicleType: "standard",
        passengerCount: 1,
        passenger: { name: "T", phone: "1" },
        raw: {},
      },
      feeSnapshot: {
        sendFeePence: 0,
        receiveFeePence: 0,
        techFeePence: 0,
        techFeeBps: 0,
        bookingFeePence: 0,
        adminFeePence: 0,
        adminFeeBps: 0,
        computedPassengerAddOnsPence: 0,
        fareAtSnapshotPence: null,
        resolvedFromFeeConfigId: "system_default",
      },
    });
    expect(r.externalId).toBe("mock-icabbi-tenA-abcdef12");
    logSpy.mockRestore();
  });

  it("falls back to partnerId.slice(0,4) as the tenant label when creds are null", async () => {
    // Seeded dev partners often have no creds — the mock still needs a stable
    // label for its deterministic ids.
    dbController.rows = [partnerRow({ id: "p-mi-2", adapterKey: "mock_icabbi", credentials: null })];
    const adapter = (await getAdapterForPartner("p-mi-2")) as MockICabbiAdapter;
    expect(adapter).toBeInstanceOf(MockICabbiAdapter);
    // Label is private — verify via the created booking's id prefix.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await adapter.createBooking({
      transitId: "12345678-0000-0000-0000-000000000000",
      recipientPartnerId: "x",
      booking: {
        originatorBookingExternalId: "O-1",
        bookingType: "asap",
        channel: "app",
        pickup: { lat: 0, lng: 0, address: "A" },
        dropoff: { lat: 1, lng: 1, address: "B" },
        vehicleType: "standard",
        passengerCount: 1,
        passenger: { name: "T", phone: "1" },
        raw: {},
      },
      feeSnapshot: {
        sendFeePence: 0,
        receiveFeePence: 0,
        techFeePence: 0,
        techFeeBps: 0,
        bookingFeePence: 0,
        adminFeePence: 0,
        adminFeeBps: 0,
        computedPassengerAddOnsPence: 0,
        fareAtSnapshotPence: null,
        resolvedFromFeeConfigId: "system_default",
      },
    });
    expect(r.externalId).toBe("mock-icabbi-p-mi-12345678"); // "p-mi" = id.slice(0,4)
    logSpy.mockRestore();
  });

  it("builds a MockCMACAdapter for adapterKey mock_cmac", async () => {
    dbController.rows = [partnerRow({ id: "p-cm", adapterKey: "mock_cmac" })];
    const adapter = await getAdapterForPartner("p-cm");
    expect(adapter).toBeInstanceOf(MockCMACAdapter);
    expect(adapter.partnerId).toBe("p-cm");
  });

  it("builds a MockFreeNowAdapter for adapterKey mock_freenow", async () => {
    dbController.rows = [partnerRow({ id: "p-fn", adapterKey: "mock_freenow" })];
    const adapter = await getAdapterForPartner("p-fn");
    expect(adapter).toBeInstanceOf(MockFreeNowAdapter);
    expect(adapter.partnerId).toBe("p-fn");
  });

  it("builds the REAL ICabbiAdapter when credentials are saved, after decryption", async () => {
    // Full live path: row → decryptIfNeeded → ICabbiAdapter, decrypt called on
    // exactly the stored creds object.
    const creds = { appKey: "AK", secretKey: "SK", webhookSecret: "WH" };
    dbController.rows = [partnerRow({ id: "p-live", adapterKey: "icabbi", credentials: creds })];

    const adapter = await getAdapterForPartner("p-live");
    expect(adapter).toBeInstanceOf(ICabbiAdapter);
    expect(adapter.key).toBe("icabbi");
    expect(adapter.partnerId).toBe("p-live");
    expect(decryptIfNeeded).toHaveBeenCalledWith(creds);
  });

  it("builds a GenericMappedAdapter for adapterKey generic_mapped (null creds tolerated)", async () => {
    // H2 config-driven path: constructs with null creds as long as a valid
    // fieldMappings config (a `fields` object) is present.
    dbController.rows = [
      partnerRow({
        id: "p-gm",
        adapterKey: "generic_mapped",
        credentials: null,
        fieldMappings: { fields: { pickup_lat: { partner_field: "pickup.lat" } } },
      }),
    ];
    const adapter = await getAdapterForPartner("p-gm");
    expect(adapter).toBeInstanceOf(GenericMappedAdapter);
    expect(adapter.key).toBe("generic_mapped");
  });

  it("propagates the GenericMappedAdapter error when fieldMappings is missing", async () => {
    // generic_mapped without a config can't translate — the constructor
    // refuses and the registry surfaces it, not a broken adapter.
    dbController.rows = [
      partnerRow({ id: "p-gm-bad", adapterKey: "generic_mapped", credentials: null, fieldMappings: null }),
    ];
    await expect(getAdapterForPartner("p-gm-bad")).rejects.toThrow(
      /fieldMappings is empty or invalid/,
    );
  });
});

describe("adapter cache", () => {
  it("returns the SAME instance on repeat calls and hits the DB only once", async () => {
    // Per-partner singleton — re-querying per routing decision would add
    // latency to every push.
    dbController.rows = [partnerRow({ id: "p-c1", adapterKey: "mock_cmac" })];

    const a1 = await getAdapterForPartner("p-c1");
    const a2 = await getAdapterForPartner("p-c1");
    expect(a1).toBe(a2);
    expect(dbController.selectCalls).toBe(1);
  });

  it("clearAdapterCache(partnerId) evicts only that partner", async () => {
    // After an edit, only the changed partner refetches; others stay warm.
    dbController.rows = [partnerRow({ id: "p-c2", adapterKey: "mock_cmac" })];
    const first = await getAdapterForPartner("p-c2");

    dbController.rows = [partnerRow({ id: "p-c3", adapterKey: "mock_freenow" })];
    const other = await getAdapterForPartner("p-c3");

    clearAdapterCache("p-c2");

    dbController.rows = [partnerRow({ id: "p-c2", adapterKey: "mock_freenow" })];
    const second = await getAdapterForPartner("p-c2");
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(MockFreeNowAdapter); // picked up the new key

    // The untouched partner is still served from cache (no extra DB call).
    const callsBefore = dbController.selectCalls;
    const otherAgain = await getAdapterForPartner("p-c3");
    expect(otherAgain).toBe(other);
    expect(dbController.selectCalls).toBe(callsBefore);
  });

  it("clearAdapterCache() with no argument evicts everything", async () => {
    dbController.rows = [partnerRow({ id: "p-c4", adapterKey: "mock_cmac" })];
    const first = await getAdapterForPartner("p-c4");

    clearAdapterCache();

    const second = await getAdapterForPartner("p-c4");
    expect(second).not.toBe(first);
    expect(dbController.selectCalls).toBe(2);
  });
});
