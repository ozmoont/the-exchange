import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import type { FeeSnapshot } from "@/db/schema";
import type { CreateBookingInput, CreateBookingResult, NormalisedBooking } from "@/lib/types";

/**
 * Routing engine tests (src/lib/routing.ts). Mocked DB + adapter registry —
 * no network, no Postgres. The db mock mirrors routing.ts's exact drizzle
 * chains and dispatches rows per table, so each test reads "given these
 * partner/rule/transit rows, the engine must do X".
 *
 * Covers routeBooking (kill-switch, no-candidates, waterfall, winner metadata,
 * idempotency), rankCandidates (eligibility, scoring, fan-out), haversineKm,
 * forwardStatusUpdate, setKillSwitch, receiveBooking, processReceivedTransits.
 * acceptDeadlineFor has its own suite (accept-deadline.test.ts); only its
 * integration into the pushed-transit update is asserted here.
 */

// DB mock — controller + drizzle-chain emulation.
// vi.mock factory below only closes over this; never dereferences at hoist time.
const dbController = {
  /** Rows returned by select().from(<table>)… for each table. */
  rows: {} as Record<string, unknown[]>,
  /** Rows for the one projected select({kind}).from(partners) query. */
  partnerKindRows: [] as unknown[],
  /** Make select() on a given table reject (drives error paths). */
  throwOnSelect: {} as Record<string, boolean>,
  /** Every update().set() call, recorded for assertions. */
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  /** What update(...).returning() resolves to per table (claim queries). */
  updateReturning: {} as Record<string, unknown[]>,
  /** Every insert().values() call, recorded for assertions. */
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  /** What insert(...).returning() resolves to per table. */
  insertReturning: {} as Record<string, unknown[]>,
};

// Identity map: shared schema module means table objects compare by reference.
const TABLE_NAMES = new Map<unknown, string>([
  [schema.partners, "partners"],
  [schema.partnerRules, "partnerRules"],
  [schema.transits, "transits"],
  [schema.transitEvents, "transitEvents"],
  [schema.auditLog, "auditLog"],
  [schema.networkControls, "networkControls"],
]);
function tableName(tbl: unknown): string {
  return TABLE_NAMES.get(tbl) ?? "unknown_table";
}

type SelectChain = {
  where: (...args: unknown[]) => SelectChain;
  orderBy: (...args: unknown[]) => SelectChain;
  limit: (...args: unknown[]) => SelectChain;
  then: (
    onFulfilled?: (rows: unknown[]) => unknown,
    onRejected?: (err: unknown) => unknown,
  ) => Promise<unknown>;
};

vi.mock("@/db/client", () => ({
  db: {
    select: (fields?: unknown) => ({
      from: (tbl: unknown) => {
        const table = tableName(tbl);
        const rowsFor = (): unknown[] => {
          if (dbController.throwOnSelect[table]) {
            throw new Error(`select(${table}) failed (test-configured)`);
          }
          // Only projected select is the originator-kind lookup — own row source
          // so it can't collide with the full partners scan.
          if (table === "partners" && fields) return dbController.partnerKindRows;
          return dbController.rows[table] ?? [];
        };
        // Thenable chain: where/orderBy/limit return the chain; awaiting resolves rows.
        const chain: SelectChain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          then: (onFulfilled, onRejected) =>
            Promise.resolve().then(rowsFor).then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    insert: (tbl: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const table = tableName(tbl);
        dbController.inserts.push({ table, values: v });
        // Awaited directly for events/audit; .returning() chained for transits — support both.
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve(dbController.insertReturning[table] ?? []),
        });
      },
    }),
    update: (tbl: unknown) => ({
      set: (v: Record<string, unknown>) => {
        const table = tableName(tbl);
        dbController.updates.push({ table, set: v });
        return {
          where: () => {
            const ret = dbController.updateReturning[table] ?? [];
            // Awaited directly for plain updates; .returning() chained for the claim query.
            return Object.assign(Promise.resolve(ret), {
              returning: () => Promise.resolve(ret),
            });
          },
        };
      },
    }),
  },
}));

// Collaborator mocks — adapters, fees, fan-out, reroute, observability.

// Adapter behaviour per recipient id. Unconfigured → throw (surfaces stray routes).
const adapterController = {
  createBooking: {} as Record<string, (input: CreateBookingInput) => Promise<CreateBookingResult>>,
  /** Recipient ids createBooking was attempted against, in order. */
  attempts: [] as string[],
};

vi.mock("@/adapters/registry", () => ({
  getAdapterForPartner: async (partnerId: string) => ({
    key: "test_adapter",
    partnerId,
    createBooking: (input: CreateBookingInput) => {
      adapterController.attempts.push(partnerId);
      const impl = adapterController.createBooking[partnerId];
      if (!impl) throw new Error(`no adapter behaviour configured for ${partnerId}`);
      return impl(input);
    },
    cancelBooking: async () => undefined,
    normaliseInboundWebhook: async () => null,
  }),
}));

// Stub (fees.test.ts owns fee logic) so scoring tests set a precise receive fee.
const feeController = { byRecipient: {} as Record<string, FeeSnapshot> };

function makeFee(receiveFeePence: number): FeeSnapshot {
  return {
    sendFeePence: 20,
    receiveFeePence,
    techFeePence: 0,
    techFeeBps: 0,
    bookingFeePence: 0,
    adminFeePence: 0,
    adminFeeBps: 0,
    computedPassengerAddOnsPence: 0,
    fareAtSnapshotPence: null,
    resolvedFromFeeConfigId: "system_default",
  };
}

vi.mock("@/lib/fees", () => ({
  resolveFeeSnapshot: async (_originatorId: string, recipientId: string) =>
    feeController.byRecipient[recipientId] ?? makeFee(40),
}));

// Fan-out quotes per recipient; absent candidates get no quote (keyed by responder).
const fanOutController = {
  quotes: new Map<
    string,
    { available: boolean; etaMinutes?: number; fareEstimatePence?: number; fromAdapter?: boolean }
  >(),
};

vi.mock("@/lib/fan-out-quote", () => ({
  fanOutQuote: async (candidates: Array<{ recipientId: string }>) =>
    candidates
      .filter((c) => fanOutController.quotes.has(c.recipientId))
      .map((c) => {
        const q = fanOutController.quotes.get(c.recipientId)!;
        return {
          recipientId: c.recipientId,
          quote: {
            available: q.available,
            etaMinutes: q.etaMinutes,
            fareEstimatePence: q.fareEstimatePence,
          },
          fromAdapter: q.fromAdapter ?? true,
          elapsedMs: 1,
        };
      }),
}));

// setKillSwitch(false) dynamically imports resumePausedTransits — controlled here.
const rerouteController = {
  result: { scanned: 0, pushed: 0, no_match: 0, paused: 0, error: 0 },
  throwOnResume: false,
  calls: [] as string[],
};

vi.mock("@/lib/reroute", () => ({
  resumePausedTransits: async (actor: string) => {
    rerouteController.calls.push(actor);
    if (rerouteController.throwOnResume) throw new Error("resume exploded (test-configured)");
    return rerouteController.result;
  },
}));

// captureError is a spy — error paths must report, never throw.
vi.mock("@/lib/observability", () => ({ captureError: vi.fn() }));

import { captureError } from "@/lib/observability";
import {
  ASAP_ACCEPT_WINDOW_MS,
  forwardStatusUpdate,
  haversineKm,
  processReceivedTransits,
  rankCandidates,
  receiveBooking,
  routeBooking,
  setKillSwitch,
} from "@/lib/routing";

// Fixtures.

const ORIG = "p-orig";
const LONDON = { lat: 51.5074, lng: -0.1278 };
// Clock pinned to a fixed June-2026 instant in beforeEach.
const NOW = new Date("2026-06-10T12:00:00Z").getTime();

function makeBooking(over: Partial<NormalisedBooking> = {}): NormalisedBooking {
  return {
    originatorBookingExternalId: "bk-1001",
    bookingType: "asap",
    channel: "app",
    pickup: { lat: LONDON.lat, lng: LONDON.lng, address: "1 Strand, London" },
    dropoff: { lat: 51.52, lng: -0.1, address: "Old Street" },
    vehicleType: "standard",
    passengerCount: 1,
    passenger: { name: "Pat", phone: "+447700900000" },
    raw: {},
    ...over,
  };
}

// Partner row with every column findEligibleRecipients touches.
// Default: active, send_and_receive, no geo (covers everywhere), no metrics.
type PartnerRow = {
  id: string;
  kind: string;
  status: string;
  participationMode: string;
  bookingTypes: string[];
  vehicleTypes: string[];
  centroidLat: number | null;
  centroidLng: number | null;
  serviceRadiusKm: number | null;
  acceptanceRate: number | null;
  totalPushed7d: number | null;
  offerWindowSeconds: number | null;
};
function partnerRow(over: Partial<PartnerRow> & { id: string }): PartnerRow {
  return {
    kind: "external",
    status: "active",
    participationMode: "send_and_receive",
    bookingTypes: ["asap", "prebook"],
    vehicleTypes: [],
    centroidLat: null,
    centroidLng: null,
    serviceRadiusKm: null,
    acceptanceRate: null,
    totalPushed7d: null,
    offerWindowSeconds: null,
    ...over,
  };
}

// Mutual allow rules — engine requires both originator→recipient and reverse.
function mutualAllow(orig: string, ids: string[]) {
  return ids.flatMap((id) => [
    { originatorId: orig, recipientId: id, rule: "allow" },
    { originatorId: id, recipientId: orig, rule: "allow" },
  ]);
}

// Happy-path network: recipients active + mutually allowed, no kill switch/transit.
function setupNetwork(recipients: PartnerRow[]) {
  dbController.rows.partners = recipients;
  dbController.rows.partnerRules = mutualAllow(ORIG, recipients.map((r) => r.id));
  dbController.rows.networkControls = [];
  dbController.rows.transits = [];
  dbController.insertReturning.transits = [{ id: "t-new" }];
}

function adapterSucceeds(id: string, extra: Partial<CreateBookingResult> = {}) {
  adapterController.createBooking[id] = async () => ({
    externalId: `ext-${id}`,
    acceptedAt: new Date().toISOString(),
    ...extra,
  });
}
function adapterFails(id: string, err: unknown) {
  adapterController.createBooking[id] = async () => {
    throw err;
  };
}

function updatesFor(table: string) {
  return dbController.updates.filter((u) => u.table === table).map((u) => u.set);
}
function insertsFor(table: string) {
  return dbController.inserts.filter((i) => i.table === table).map((i) => i.values);
}

const SAVED_KILL_SWITCH_ENV = process.env.NETWORK_KILL_SWITCH;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  delete process.env.NETWORK_KILL_SWITCH;
  dbController.rows = {};
  dbController.partnerKindRows = [];
  dbController.throwOnSelect = {};
  dbController.updates = [];
  dbController.updateReturning = {};
  dbController.inserts = [];
  dbController.insertReturning = {};
  adapterController.createBooking = {};
  adapterController.attempts = [];
  feeController.byRecipient = {};
  fanOutController.quotes.clear();
  rerouteController.result = { scanned: 0, pushed: 0, no_match: 0, paused: 0, error: 0 };
  rerouteController.throwOnResume = false;
  rerouteController.calls = [];
  vi.mocked(captureError).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  // Restore — kill-switch tests set this env var.
  if (SAVED_KILL_SWITCH_ENV === undefined) delete process.env.NETWORK_KILL_SWITCH;
  else process.env.NETWORK_KILL_SWITCH = SAVED_KILL_SWITCH_ENV;
});

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    // Degenerate input must not divide by zero or go NaN.
    expect(haversineKm(LONDON.lat, LONDON.lng, LONDON.lat, LONDON.lng)).toBe(0);
  });

  it("computes ~111.19km for one degree of latitude", () => {
    // Anchor: 1° lat = π·R/180 ≈ 111.19km (R=6371). Locks radius + radian conversion.
    expect(haversineKm(50, 0, 51, 0)).toBeCloseTo(111.19, 1);
  });

  it("computes London → Paris within real-world tolerance (~344km)", () => {
    // Known city pair catches sign/argument-order bugs the symmetric test misses.
    const d = haversineKm(LONDON.lat, LONDON.lng, 48.8566, 2.3522);
    expect(d).toBeGreaterThan(340);
    expect(d).toBeLessThan(348);
  });

  it("is symmetric in its arguments", () => {
    // Used both ways: service-area (partner→pickup) and scoring (pickup→partner).
    const ab = haversineKm(51.5, -0.1, 53.4, -2.2);
    const ba = haversineKm(53.4, -2.2, 51.5, -0.1);
    expect(ab).toBeCloseTo(ba, 10);
  });
});

describe("routeBooking — kill switch", () => {
  it("parks the booking at 'paused' when the DB kill switch is on", async () => {
    // Network halted: no adapter called, transit lands 'paused' with kill_switch event.
    dbController.rows.networkControls = [{ id: "global", killSwitch: true }];
    dbController.rows.transits = [];
    dbController.insertReturning.transits = [{ id: "t-paused" }];

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r).toEqual({ transitId: "t-paused", outcome: "paused" });
    expect(insertsFor("transits")[0]).toMatchObject({ status: "paused" });
    expect(insertsFor("transitEvents")[0]).toMatchObject({
      transitId: "t-paused",
      status: "paused",
      detail: { reason: "kill_switch" },
    });
    expect(adapterController.attempts).toEqual([]); // nothing pushed
  });

  it("honours NETWORK_KILL_SWITCH=true from the environment when no control row exists", async () => {
    // Break-glass override (for when the DB is the problem); must work with zero rows.
    process.env.NETWORK_KILL_SWITCH = "true";
    dbController.rows.networkControls = [];
    dbController.rows.transits = [];
    dbController.insertReturning.transits = [{ id: "t-env" }];

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r.outcome).toBe("paused");
    expect(adapterController.attempts).toEqual([]);
  });

  it("routes normally when a control row exists with killSwitch=false", async () => {
    // A present-but-off row must NOT pause (row existence ≠ switch on).
    setupNetwork([partnerRow({ id: "p-a" })]);
    dbController.rows.networkControls = [{ id: "global", killSwitch: false }];
    adapterSucceeds("p-a");

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });
    expect(r.outcome).toBe("pushed");
  });
});

describe("routeBooking — no candidates", () => {
  it("marks the transit no_match when no partner is eligible", async () => {
    // Empty network: transit terminates at no_match (no_eligible_partner), not stuck 'routing'.
    setupNetwork([]); // no partners at all

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r.outcome).toBe("no_match");
    expect(updatesFor("transits")[0]).toMatchObject({ status: "no_match" });
    const events = insertsFor("transitEvents");
    // events[0] = created at 'routing'; events[1] = no_match mark.
    expect(events[1]).toMatchObject({
      status: "no_match",
      detail: { reason: "no_eligible_partner" },
    });
  });
});

describe("routeBooking — waterfall", () => {
  it("pushes to the first-ranked candidate and records full winner metadata", async () => {
    // Winner's externalId, fee snapshot, partnership coid + tracking link must all
    // land on the transit row — read later by reconciliation + passenger UI.
    setupNetwork([partnerRow({ id: "p-a" })]);
    adapterSucceeds("p-a", {
      partnership: { coid: "coid-1", clientId: "cli-1", serverName: "srv-1", siteId: "site-1" },
      trackMyTaxiLink: "https://track.example/abc",
    });

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r).toEqual({ transitId: "t-new", outcome: "pushed" });
    const push = updatesFor("transits")[0];
    expect(push).toMatchObject({
      status: "pushed",
      recipientPartnerId: "p-a",
      recipientBookingExternalId: "ext-p-a",
      partnershipCoid: "coid-1",
      recipientClientId: "cli-1",
      recipientServerName: "srv-1",
      recipientSiteId: "site-1",
      trackMyTaxiLink: "https://track.example/abc",
    });
    expect((push.feeSnapshot as FeeSnapshot).receiveFeePence).toBe(40);
    const trace = push.routingTrace as { winner: string; consideredCount: number };
    expect(trace.winner).toBe("p-a");
    expect(trace.consideredCount).toBe(1);
    // 'pushed' event carries the attempt count for audit.
    const pushedEvent = insertsFor("transitEvents").find((e) => e.status === "pushed");
    expect(pushedEvent).toMatchObject({
      detail: { recipientBookingExternalId: "ext-p-a", waterfallAttempts: 1 },
    });
  });

  it("sets acceptDeadline from the booking-type default when the winner has no offer window", async () => {
    // Integration with acceptDeadlineFor: ASAP push, no offerWindowSeconds → now + 90s.
    setupNetwork([partnerRow({ id: "p-a" })]);
    adapterSucceeds("p-a");

    await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    const push = updatesFor("transits")[0];
    expect((push.acceptDeadline as Date).getTime()).toBe(NOW + ASAP_ACCEPT_WINDOW_MS);
  });

  it("sets acceptDeadline from the winner's declared offerWindowSeconds", async () => {
    // BDD §7 NFR: winner's own offer window drives the deadline, not the global default.
    setupNetwork([partnerRow({ id: "p-a", offerWindowSeconds: 120 })]);
    adapterSucceeds("p-a");

    await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    const push = updatesFor("transits")[0];
    expect((push.acceptDeadline as Date).getTime()).toBe(NOW + 120_000);
  });

  it("falls through to the next candidate when the first adapter fails, classifying auth errors", async () => {
    // Waterfall core: rank-0 throws 401 → error_auth, rank-1 wins; trace keeps
    // BOTH attempts so an operator sees why the cheaper partner was skipped.
    const close = partnerRow({ id: "p-close", centroidLat: LONDON.lat, centroidLng: LONDON.lng });
    const far = partnerRow({ id: "p-far" }); // no geo → neutral 25km → ranks second
    setupNetwork([close, far]);
    adapterFails("p-close", new Error("401 Unauthorized from partner API"));
    adapterSucceeds("p-far");

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r.outcome).toBe("pushed");
    expect(adapterController.attempts).toEqual(["p-close", "p-far"]);
    const push = updatesFor("transits")[0];
    expect(push.recipientPartnerId).toBe("p-far");
    // Winner had no partnership/tracking info → columns stay null.
    expect(push.partnershipCoid).toBeNull();
    expect(push.trackMyTaxiLink).toBeNull();
    const trace = push.routingTrace as {
      winner: string;
      waterfallAttempts: Array<{ recipientId: string; rank: number; outcome: string; error?: string }>;
    };
    expect(trace.winner).toBe("p-far");
    expect(trace.waterfallAttempts).toHaveLength(2);
    expect(trace.waterfallAttempts[0]).toMatchObject({
      recipientId: "p-close",
      rank: 0,
      outcome: "error_auth",
    });
    expect(trace.waterfallAttempts[1]).toMatchObject({
      recipientId: "p-far",
      rank: 1,
      outcome: "pushed",
    });
  });

  it("ends at error_other when every candidate fails, keeping the full trace", async () => {
    // All-fail: transit → error_other + all_candidates_failed event. One throws an
    // Error, the other a bare string — covers the non-Error String(err) branch.
    const a = partnerRow({ id: "p-a", centroidLat: LONDON.lat, centroidLng: LONDON.lng });
    const b = partnerRow({ id: "p-b" });
    setupNetwork([a, b]);
    adapterFails("p-a", new Error("connection reset"));
    adapterFails("p-b", "plain string failure"); // non-Error throw

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r.outcome).toBe("error");
    const errUpdate = updatesFor("transits")[0];
    expect(errUpdate.status).toBe("error_other");
    const trace = errUpdate.routingTrace as {
      winner: string | null;
      waterfallAttempts: Array<{ outcome: string; error?: string }>;
    };
    expect(trace.winner).toBeNull();
    expect(trace.waterfallAttempts.map((x) => x.outcome)).toEqual(["error_other", "error_other"]);
    expect(trace.waterfallAttempts[1].error).toBe("plain string failure");
    const events = insertsFor("transitEvents");
    expect(events[1]).toMatchObject({
      status: "error_other",
      detail: { reason: "all_candidates_failed", attempts: 2 },
    });
  });

  it("stops after MAX_WATERFALL (5) attempts even with more candidates", async () => {
    // Blast-radius guard: six eligible all-failing candidates → only first five attempted.
    const six = Array.from({ length: 6 }, (_, i) => partnerRow({ id: `p-${i}` }));
    setupNetwork(six);
    six.forEach((p) => adapterFails(p.id, new Error("down")));

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r.outcome).toBe("error");
    expect(adapterController.attempts).toHaveLength(5);
    const trace = updatesFor("transits")[0].routingTrace as {
      consideredCount: number;
      waterfallAttempts: unknown[];
    };
    expect(trace.consideredCount).toBe(6);
    expect(trace.waterfallAttempts).toHaveLength(5);
  });

  it("truncates adapter error messages to 200 chars in the trace", async () => {
    // routingTrace jsonb is read by the admin UI — unbounded stack traces must not bloat it.
    setupNetwork([partnerRow({ id: "p-a" })]);
    adapterFails("p-a", new Error("x".repeat(500)));

    await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    const trace = updatesFor("transits")[0].routingTrace as {
      waterfallAttempts: Array<{ error?: string }>;
    };
    expect(trace.waterfallAttempts[0].error).toHaveLength(200);
  });

  it("reuses an existing transit row (idempotency on originator + external booking id)", async () => {
    // Duplicate delivery must NOT create a second transit; routing reuses the existing row.
    setupNetwork([partnerRow({ id: "p-a" })]);
    dbController.rows.transits = [{ id: "t-existing" }];
    adapterSucceeds("p-a");

    const r = await routeBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r).toEqual({ transitId: "t-existing", outcome: "pushed" });
    expect(insertsFor("transits")).toHaveLength(0); // no duplicate insert
  });
});

describe("rankCandidates — eligibility", () => {
  it("returns [] when the originator is the only partner on the network", async () => {
    // A partner never receives its own booking; nobody else → zero candidates (early return).
    dbController.rows.partners = [partnerRow({ id: ORIG })];
    dbController.rows.partnerRules = [];

    expect(await rankCandidates(ORIG, makeBooking())).toEqual([]);
  });

  it("excludes the originator from the candidate list", async () => {
    // The originator's own row (from the active-partners scan) must be filtered out.
    dbController.rows.partners = [partnerRow({ id: ORIG }), partnerRow({ id: "p-a" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-a"]);

    const ranked = await rankCandidates(ORIG, makeBooking());
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-a"]);
  });

  it("requires a mutual allow — outbound-only allow is not enough", async () => {
    // Trust is bidirectional: outbound allow without the reciprocal one excludes.
    dbController.rows.partners = [partnerRow({ id: "p-a" })];
    dbController.rows.partnerRules = [{ originatorId: ORIG, recipientId: "p-a", rule: "allow" }];

    expect(await rankCandidates(ORIG, makeBooking())).toEqual([]);
  });

  it("ignores 'block' rules when building the allow sets", async () => {
    // A block in either direction is not an allow — candidate excluded.
    dbController.rows.partners = [partnerRow({ id: "p-a" })];
    dbController.rows.partnerRules = [
      { originatorId: ORIG, recipientId: "p-a", rule: "allow" },
      { originatorId: "p-a", recipientId: ORIG, rule: "block" },
    ];

    expect(await rankCandidates(ORIG, makeBooking())).toEqual([]);
  });

  it("excludes partners that don't serve the booking type", async () => {
    // A prebook-only partner must not see ASAP work.
    dbController.rows.partners = [
      partnerRow({ id: "p-prebook-only", bookingTypes: ["prebook"] }),
      partnerRow({ id: "p-both" }),
    ];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-prebook-only", "p-both"]);

    const ranked = await rankCandidates(ORIG, makeBooking({ bookingType: "asap" }));
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-both"]);
  });

  it("treats an empty vehicleTypes list as 'any vehicle', and filters non-matching lists", async () => {
    // vehicleTypes=[] is the back-compat wildcard; non-empty = exact-match whitelist.
    dbController.rows.partners = [
      partnerRow({ id: "p-any", vehicleTypes: [] }),
      partnerRow({ id: "p-exec-only", vehicleTypes: ["exec"] }),
      partnerRow({ id: "p-standard", vehicleTypes: ["standard", "exec"] }),
    ];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-any", "p-exec-only", "p-standard"]);

    const ranked = await rankCandidates(ORIG, makeBooking({ vehicleType: "standard" }));
    expect(ranked.map((c) => c.recipientId).sort()).toEqual(["p-any", "p-standard"]);
  });

  it("excludes partners whose service radius doesn't reach the pickup", async () => {
    // Pickup ~10km from both centroids: radius 5 → out, radius 15 → in.
    const centroid = { centroidLat: LONDON.lat + 0.09, centroidLng: LONDON.lng };
    dbController.rows.partners = [
      partnerRow({ id: "p-small", ...centroid, serviceRadiusKm: 5 }),
      partnerRow({ id: "p-big", ...centroid, serviceRadiusKm: 15 }),
    ];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-small", "p-big"]);

    const ranked = await rankCandidates(ORIG, makeBooking());
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-big"]);
    // distanceKm surfaced on the candidate for the trace UI.
    expect(ranked[0].distanceKm).toBeCloseTo(10.0, 0);
  });

  it("treats partners without geo data as covering everywhere (back-compat)", async () => {
    // Null centroid/radius → always in area, distanceKm stays null.
    dbController.rows.partners = [partnerRow({ id: "p-nogeo" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-nogeo"]);

    const ranked = await rankCandidates(ORIG, makeBooking());
    expect(ranked).toHaveLength(1);
    expect(ranked[0].distanceKm).toBeNull();
  });

  it("excludes ALL iCabbi-kind recipients when the originator is an iCabbi fleet (loop detection)", async () => {
    // STRATEGY.md #12 / BDD 4.2: iCabbi overflow must never bounce to another
    // iCabbi tenant (driverless tenants would hot-potato forever).
    dbController.partnerKindRows = [{ kind: "icabbi_fleet" }];
    dbController.rows.partners = [
      partnerRow({ id: "p-icabbi", kind: "icabbi_fleet" }),
      partnerRow({ id: "p-cmac", kind: "external" }),
    ];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-icabbi", "p-cmac"]);

    const ranked = await rankCandidates(ORIG, makeBooking());
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-cmac"]);
  });

  it("does not apply the iCabbi exclusion for non-iCabbi originators", async () => {
    // Loop guard is one-directional: a CMAC-kind originator may route INTO iCabbi.
    dbController.partnerKindRows = [{ kind: "external" }];
    dbController.rows.partners = [partnerRow({ id: "p-icabbi", kind: "icabbi_fleet" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-icabbi"]);

    const ranked = await rankCandidates(ORIG, makeBooking());
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-icabbi"]);
  });
});

describe("rankCandidates — scoring", () => {
  it("scores fee + 5p/km: a closer-but-pricier partner beats a cheaper-but-distant one", async () => {
    // Documented trade-off: 5p/km, so 10km (~50p) outweighs a 10p fee saving.
    const atPickup = partnerRow({ id: "p-near", centroidLat: LONDON.lat, centroidLng: LONDON.lng });
    const tenKmAway = partnerRow({
      id: "p-cheap",
      centroidLat: LONDON.lat + 0.09,
      centroidLng: LONDON.lng,
    });
    dbController.rows.partners = [atPickup, tenKmAway];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-near", "p-cheap"]);
    feeController.byRecipient["p-near"] = makeFee(40);
    feeController.byRecipient["p-cheap"] = makeFee(30);

    const ranked = await rankCandidates(ORIG, makeBooking());

    expect(ranked.map((c) => c.recipientId)).toEqual(["p-near", "p-cheap"]);
    // Breakdown reconciles: score = feeTerm + distanceTerm.
    expect(ranked[0].feeTerm).toBe(40);
    expect(ranked[0].distanceTerm).toBe(0);
    expect(ranked[0].score).toBe(40);
    expect(ranked[1].feeTerm).toBe(30);
    expect(ranked[1].distanceTerm).toBeCloseTo(ranked[1].distanceKm! * 5, 6);
    expect(ranked[1].score).toBeCloseTo(30 + ranked[1].distanceTerm, 6);
  });

  it("gives partners without geo a neutral 25km distance so fee dominates", async () => {
    // No centroid → effectiveDistance 25km → distanceTerm 125, reported distanceKm null.
    dbController.rows.partners = [partnerRow({ id: "p-nogeo" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-nogeo"]);
    feeController.byRecipient["p-nogeo"] = makeFee(40);

    const [c] = await rankCandidates(ORIG, makeBooking());
    expect(c.distanceKm).toBeNull();
    expect(c.distanceTerm).toBe(125);
    expect(c.score).toBe(165);
  });

  it("adds the reliability penalty to the score and can flip the ranking", async () => {
    // Two identical partners; 50%/10 adds a 100-pt penalty (MAX*0.5), demoting the
    // flaky one. Uses the REAL reliabilityPenalty.
    const geo = { centroidLat: LONDON.lat, centroidLng: LONDON.lng };
    dbController.rows.partners = [
      partnerRow({ id: "p-flaky", ...geo, acceptanceRate: 0.5, totalPushed7d: 10 }),
      partnerRow({ id: "p-solid", ...geo, acceptanceRate: 0.95, totalPushed7d: 10 }),
    ];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-flaky", "p-solid"]);

    const ranked = await rankCandidates(ORIG, makeBooking());

    expect(ranked.map((c) => c.recipientId)).toEqual(["p-solid", "p-flaky"]);
    expect(ranked[1].reliabilityPenaltyApplied).toBe(100);
    expect(ranked[0].reliabilityPenaltyApplied).toBeCloseTo(10, 6); // 200 * 0.05
    // Rate + sample echoed on the candidate for the trace UI.
    expect(ranked[1].acceptanceRate).toBe(0.5);
    expect(ranked[1].totalPushed7d).toBe(10);
  });

  it("propagates the partner's offerWindowSeconds onto the candidate", async () => {
    // routeBooking reads candidate.offerWindowSeconds; losing it disables per-partner SLAs.
    dbController.rows.partners = [partnerRow({ id: "p-a", offerWindowSeconds: 300 })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-a"]);

    const [c] = await rankCandidates(ORIG, makeBooking());
    expect(c.offerWindowSeconds).toBe(300);
  });
});

describe("rankCandidates — fan-out (useFanOut: true)", () => {
  it("drops candidates whose live quote said available:false", async () => {
    // A1: a partner that says "no right now" must not appear in the ranking.
    dbController.rows.partners = [partnerRow({ id: "p-busy" }), partnerRow({ id: "p-free" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-busy", "p-free"]);
    fanOutController.quotes.set("p-busy", { available: false });
    fanOutController.quotes.set("p-free", { available: true, etaMinutes: 5 });

    const ranked = await rankCandidates(ORIG, makeBooking(), { useFanOut: true });
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-free"]);
  });

  it("weights live ETA into the score at 8 points per minute and exposes liveQuote", async () => {
    // A1 scoring: etaTerm = etaMinutes * 8 added to score; raw quote surfaced via liveQuote.
    const geo = { centroidLat: LONDON.lat, centroidLng: LONDON.lng };
    dbController.rows.partners = [
      partnerRow({ id: "p-slow", ...geo }),
      partnerRow({ id: "p-fast", ...geo }),
    ];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-slow", "p-fast"]);
    fanOutController.quotes.set("p-slow", { available: true, etaMinutes: 10, fareEstimatePence: 900 });
    fanOutController.quotes.set("p-fast", { available: true, etaMinutes: 2, fareEstimatePence: 1100 });

    const ranked = await rankCandidates(ORIG, makeBooking(), { useFanOut: true });

    // Same fee + distance → ETA decides: 2min (16) < 10min (80).
    expect(ranked.map((c) => c.recipientId)).toEqual(["p-fast", "p-slow"]);
    expect(ranked[0].etaTerm).toBe(16);
    expect(ranked[0].score).toBe(40 + 16);
    expect(ranked[0].liveQuote).toEqual({
      etaMinutes: 2,
      fareEstimatePence: 1100,
      fromAdapter: true,
    });
    expect(ranked[1].etaTerm).toBe(80);
  });

  it("keeps candidates that returned no quote entry, with no etaTerm/liveQuote", async () => {
    // No fan-out result → still eligible (metadata-only scoring), not dropped.
    dbController.rows.partners = [partnerRow({ id: "p-silent" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-silent"]);
    // fanOutController has no entry for p-silent.

    const ranked = await rankCandidates(ORIG, makeBooking(), { useFanOut: true });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).not.toHaveProperty("liveQuote");
    expect(ranked[0]).not.toHaveProperty("etaTerm");
    expect(ranked[0].score).toBe(40 + 125); // fee + neutral-distance only
  });

  it("treats a quote without etaMinutes as etaTerm 0 but still surfaces liveQuote", async () => {
    // available:true, no ETA → no ETA penalty, liveQuote.etaMinutes normalised to null.
    dbController.rows.partners = [partnerRow({ id: "p-noeta" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-noeta"]);
    fanOutController.quotes.set("p-noeta", { available: true });

    const [c] = await rankCandidates(ORIG, makeBooking(), { useFanOut: true });
    expect(c.etaTerm).toBe(0);
    expect(c.liveQuote).toEqual({ etaMinutes: null, fareEstimatePence: null, fromAdapter: true });
  });

  it("does not attach liveQuote when fan-out is disabled (default options)", async () => {
    // Metadata-only mode must not leak fan-out fields even if a quote exists.
    dbController.rows.partners = [partnerRow({ id: "p-a" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-a"]);
    fanOutController.quotes.set("p-a", { available: true, etaMinutes: 3 });

    const [c] = await rankCandidates(ORIG, makeBooking()); // no options
    expect(c).not.toHaveProperty("liveQuote");
    expect(c.score).toBe(40 + 125); // ETA played no part
  });
});

describe("forwardStatusUpdate", () => {
  it("clears the accept deadline when the booking advances past pushed", async () => {
    // Once recipient commits (accepted+), acceptDeadline must be nulled in the SAME update
    // so the auto-reroute job stops watching.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbController.rows.transits = [
      { id: "t-1", originatorPartnerId: ORIG, originatorBookingExternalId: "bk-1" },
    ];

    await forwardStatusUpdate({ transitId: "t-1", newStatus: "accepted", detail: { via: "webhook" } });

    expect(updatesFor("transits")[0]).toMatchObject({ status: "accepted", acceptDeadline: null });
    expect(insertsFor("transitEvents")[0]).toMatchObject({
      transitId: "t-1",
      status: "accepted",
      detail: { via: "webhook" },
      actor: "partner_webhook",
    });
    // Transit found → traceability line logged.
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("leaves the accept deadline alone for a defensive 'pushed' status", async () => {
    // Defensive branch: status 'pushed' must NOT clear the deadline (no commit yet).
    dbController.rows.transits = [{ id: "t-1", originatorPartnerId: ORIG }];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await forwardStatusUpdate({ transitId: "t-1", newStatus: "pushed" });

    expect(updatesFor("transits")[0]).not.toHaveProperty("acceptDeadline");
    logSpy.mockRestore();
  });

  it("skips the log line when the transit row is not found", async () => {
    // Webhook for unknown transit id: event still recorded, no crash, no log on missing row.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbController.rows.transits = [];

    await forwardStatusUpdate({ transitId: "t-ghost", newStatus: "completed" });

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("setKillSwitch", () => {
  it("turns ON via update when a control row exists, audit-logging before/after", async () => {
    // Audit 'before' must be the pre-toggle state — makes the history reconstructable.
    const existing = { id: "global", killSwitch: false, killSwitchReason: null };
    dbController.rows.networkControls = [existing];

    const r = await setKillSwitch(true, "incident-42", "miro");

    expect(r).toEqual({ on: true }); // no resume info on ON
    expect(updatesFor("networkControls")[0]).toMatchObject({
      killSwitch: true,
      killSwitchReason: "incident-42",
      killSwitchToggledBy: "miro",
    });
    expect(insertsFor("auditLog")[0]).toMatchObject({
      action: "kill_switch.on",
      actorRef: "miro",
      subjectType: "network",
      subjectId: "global",
      before: existing,
    });
    expect(rerouteController.calls).toEqual([]); // ON never resumes
  });

  it("turns ON via insert when no control row exists yet", async () => {
    // First-ever toggle: the global row is created, not updated.
    dbController.rows.networkControls = [];

    await setKillSwitch(true, "first toggle", "admin");

    expect(updatesFor("networkControls")).toHaveLength(0);
    expect(insertsFor("networkControls")[0]).toMatchObject({ id: "global", killSwitch: true });
    // No prior row → audit 'before' is null.
    expect(insertsFor("auditLog")[0].before).toBeNull();
  });

  it("turns OFF and resumes paused transits, returning the resume outcome", async () => {
    // OFF must replay paused transits (nothing strands) and return per-outcome counts.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbController.rows.networkControls = [{ id: "global", killSwitch: true }];
    rerouteController.result = { scanned: 3, pushed: 2, no_match: 1, paused: 0, error: 0 };

    const r = await setKillSwitch(false, "all clear", "miro");

    expect(rerouteController.calls).toEqual(["miro"]);
    expect(r).toEqual({ on: false, resumed: { scanned: 3, pushed: 2, no_match: 1, paused: 0, error: 0 } });
    expect(insertsFor("auditLog")[0]).toMatchObject({ action: "kill_switch.off" });
    expect(logSpy).toHaveBeenCalledTimes(1); // summary logged because scanned > 0
    logSpy.mockRestore();
  });

  it("turns OFF quietly when there was nothing to resume", async () => {
    // scanned=0 → no log noise, but resumed counts still returned.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbController.rows.networkControls = [{ id: "global", killSwitch: true }];

    const r = await setKillSwitch(false, "quiet", "miro");

    expect(r.resumed).toEqual({ scanned: 0, pushed: 0, no_match: 0, paused: 0, error: 0 });
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("does not fail the OFF toggle when the resume blows up — captures the error instead", async () => {
    // Resilience: a broken resume must not strand the switch ON. Toggle persists,
    // error captured, `resumed` omitted.
    dbController.rows.networkControls = [{ id: "global", killSwitch: true }];
    rerouteController.throwOnResume = true;

    const r = await setKillSwitch(false, "risky", "miro");

    expect(r).toEqual({ on: false }); // no resumed key
    expect(updatesFor("networkControls")[0]).toMatchObject({ killSwitch: false });
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: "kill_switch_off_resume" }),
    );
  });
});

describe("receiveBooking", () => {
  it("records a new booking at 'received' and returns immediately", async () => {
    // P0-3 async ingest: webhook writes status='received' + webhook_ingest event;
    // routing happens later in the drain.
    dbController.rows.transits = [];
    dbController.rows.networkControls = [];
    dbController.insertReturning.transits = [{ id: "t-rx" }];

    const r = await receiveBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r).toEqual({ transitId: "t-rx", outcome: "received" });
    expect(insertsFor("transits")[0]).toMatchObject({ status: "received" });
    expect(insertsFor("transitEvents")[0]).toMatchObject({
      status: "received",
      detail: { source: "webhook_ingest" },
    });
  });

  it("returns 'duplicate' without writing anything when the transit already exists", async () => {
    // Idempotency: same (originator, externalId) → existing id back, zero rows written.
    dbController.rows.transits = [{ id: "t-dup" }];

    const r = await receiveBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r).toEqual({ transitId: "t-dup", outcome: "duplicate" });
    expect(dbController.inserts).toHaveLength(0);
    expect(dbController.updates).toHaveLength(0);
  });

  it("lands the transit at 'paused' when the kill switch is engaged", async () => {
    // During a halt, inbound bookings park at paused (kill_switch reason) for resume.
    dbController.rows.transits = [];
    dbController.rows.networkControls = [{ id: "global", killSwitch: true }];
    dbController.insertReturning.transits = [{ id: "t-paused-rx" }];

    const r = await receiveBooking({ originatorPartnerId: ORIG, booking: makeBooking() });

    expect(r).toEqual({ transitId: "t-paused-rx", outcome: "paused" });
    expect(insertsFor("transitEvents")[0]).toMatchObject({
      status: "paused",
      detail: { reason: "kill_switch" },
    });
  });
});

describe("processReceivedTransits", () => {
  // A transit row as the drain reads it back, carrying the payload re-hydrated
  // into a NormalisedBooking for routeBooking.
  function receivedTransit(id: string) {
    return {
      id,
      status: "received",
      originatorPartnerId: ORIG,
      originatorBookingExternalId: "bk-1001",
      bookingPayload: makeBooking() as unknown as Record<string, unknown>,
      createdAt: new Date(NOW - 1000),
    };
  }

  it("returns all-zero outcomes when nothing is queued", async () => {
    dbController.rows.transits = [];

    const out = await processReceivedTransits();
    expect(out).toEqual({ scanned: 0, pushed: 0, no_match: 0, paused: 0, error: 0, skipped: 0 });
  });

  it("claims a received transit and routes it through to 'pushed'", async () => {
    // E2E drain: claim wins, routeBooking reuses the transit, adapter accepts → pushed.
    dbController.rows.transits = [receivedTransit("t-q1")];
    dbController.updateReturning.transits = [{ id: "t-q1" }]; // claim wins
    dbController.rows.partners = [partnerRow({ id: "p-a" })];
    dbController.rows.partnerRules = mutualAllow(ORIG, ["p-a"]);
    dbController.rows.networkControls = [];
    adapterSucceeds("p-a");

    const out = await processReceivedTransits();

    expect(out).toMatchObject({ scanned: 1, pushed: 1, skipped: 0, error: 0 });
    // First transits update = claim ('routing'); a later one = push.
    expect(updatesFor("transits")[0]).toMatchObject({ status: "routing" });
    expect(updatesFor("transits").some((u) => u.status === "pushed")).toBe(true);
  });

  it("skips a transit another worker claimed first", async () => {
    // Concurrency: claim UPDATE returns no row → a parallel drain won; move on, don't re-route.
    dbController.rows.transits = [receivedTransit("t-q1")];
    dbController.updateReturning.transits = []; // claim lost the race

    const out = await processReceivedTransits();

    expect(out).toMatchObject({ scanned: 1, skipped: 1, pushed: 0, error: 0 });
    expect(adapterController.attempts).toEqual([]);
  });

  it("counts a routing crash as error and captures it without aborting the drain", async () => {
    // One poisoned transit must not kill the cron: error captured with id, drain returns.
    dbController.rows.transits = [receivedTransit("t-boom")];
    dbController.updateReturning.transits = [{ id: "t-boom" }];
    dbController.throwOnSelect.networkControls = true; // routeBooking dies on kill-switch read

    const out = await processReceivedTransits();

    expect(out).toMatchObject({ scanned: 1, error: 1 });
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: "process_queue", transit_id: "t-boom" }),
    );
  });

  it("counts kill-switch outcomes as paused", async () => {
    // Switch flipped on between receive and drain: routeBooking parks the transit
    // (reusing the row), drain tallies 'paused'.
    dbController.rows.transits = [receivedTransit("t-q1")];
    dbController.updateReturning.transits = [{ id: "t-q1" }];
    dbController.rows.networkControls = [{ id: "global", killSwitch: true }];

    const out = await processReceivedTransits();
    expect(out).toMatchObject({ scanned: 1, paused: 1 });
  });
});
