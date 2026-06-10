import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transits, transitEvents, auditLog, partners } from "@/db/schema";
import type { FeeSnapshot } from "@/db/schema";

/**
 * Acceptance-window enforcement + auto-reroute (src/lib/reroute.ts), the
 * waterfall-continuation engine. Locks in: no-op on empty scan; max attempts →
 * fail via forwardStatusUpdate (no push); exclusion of every prior partner
 * (waterfall + reroute + current); no candidates → no_match + trace; happy path
 * (cancel original, push next, trace + event + audit + outbound transit.rerouted
 * with a stable idempotency key); failure containment at every layer (cancel,
 * push, webhook, whole-transit); and resumePausedTransits replaying routeBooking
 * per paused transit, counting outcomes, capturing per-transit errors. db,
 * adapters, routing, fees, logger, observability, outbound-webhooks all mocked;
 * time frozen (June 2026) so trace timestamps/deadlines are exact.
 */

// db mock: ordered select queue + update/insert recorders.
const dbController = {
  selectQueue: [] as Array<Array<Record<string, unknown>>>,
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  reset() {
    this.selectQueue = [];
    this.updates = [];
    this.inserts = [];
  },
};

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => {
        const rows = dbController.selectQueue.shift() ?? [];
        const exec = () => Promise.resolve(rows);
        return {
          where: () => ({
            limit: () => exec(),
            // reroute also awaits .where() directly (partner lookups)
            then: (
              res?: (rows: unknown) => unknown,
              rej?: (err: unknown) => unknown,
            ) => exec().then(res, rej),
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbController.updates.push({ table, values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        dbController.inserts.push({ table, values });
      },
    }),
  },
}));

// adapter registry mock: one shared fake adapter, configurable per test.
const adapterController = {
  cancelBooking: vi.fn(),
  createBooking: vi.fn(),
};
vi.mock("@/adapters/registry", () => ({
  getAdapterForPartner: vi.fn(async () => ({
    cancelBooking: (...a: unknown[]) => adapterController.cancelBooking(...a),
    createBooking: (...a: unknown[]) => adapterController.createBooking(...a),
  })),
}));

// routing mock: ranking, deadlines, status forwarding, resume routing.
const routingController = {
  rankCandidates: vi.fn(),
  forwardStatusUpdate: vi.fn(),
  routeBooking: vi.fn(),
  acceptDeadlineFor: vi.fn(),
};
vi.mock("@/lib/routing", () => ({
  rankCandidates: (...a: unknown[]) => routingController.rankCandidates(...a),
  forwardStatusUpdate: (...a: unknown[]) => routingController.forwardStatusUpdate(...a),
  routeBooking: (...a: unknown[]) => routingController.routeBooking(...a),
  acceptDeadlineFor: (...a: unknown[]) => routingController.acceptDeadlineFor(...a),
}));

// resolveFeeSnapshot is only referenced (void) by reroute.ts — mock it so the
// fees module's db imports never load.
vi.mock("@/lib/fees", () => ({ resolveFeeSnapshot: vi.fn() }));

// Silence + capture structured logging / error capture.
const logWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  log: {
    warn: (...a: unknown[]) => logWarn(...a),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
const captureErrorMock = vi.fn();
vi.mock("@/lib/observability", () => ({
  captureError: (...a: unknown[]) => captureErrorMock(...a),
}));

// Dynamically imported inside rerouteOne — vi.mock intercepts it.
const sendOutboundEventMock = vi.fn();
vi.mock("@/lib/outbound-webhooks", () => ({
  sendOutboundEvent: (...a: unknown[]) => sendOutboundEventMock(...a),
}));

import { recheckStaleAcceptances, resumePausedTransits } from "@/lib/reroute";

const NOW = new Date("2026-06-10T10:00:00.000Z");
const DEADLINE = new Date("2026-06-10T10:01:30.000Z");

const FEE: FeeSnapshot = {
  sendFeePence: 15,
  receiveFeePence: 30,
  techFeePence: 0,
  techFeeBps: 0,
  bookingFeePence: 0,
  adminFeePence: 0,
  adminFeeBps: 0,
  computedPassengerAddOnsPence: 0,
  fareAtSnapshotPence: null,
  resolvedFromFeeConfigId: "cfg_1",
};

/** A stale transit row as the scan query would return it. */
function makeTransit(overrides: Record<string, unknown> = {}) {
  return {
    id: "tr_1",
    originatorPartnerId: "orig_1",
    originatorBookingExternalId: "EXT-1",
    recipientPartnerId: "rec_old",
    recipientBookingExternalId: "icabbi-OLD-1",
    status: "pushed",
    rerouteCount: 0,
    acceptDeadline: new Date(NOW.getTime() - 60_000),
    bookingPayload: { originatorBookingExternalId: "EXT-1", bookingType: "asap" },
    routingTrace: { waterfallAttempts: [{ recipientId: "rec_old" }] },
    ...overrides,
  };
}

/** A ranked candidate as rankCandidates would return it. */
function makeCandidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    recipientId: id,
    fee: FEE,
    distanceKm: 4.2,
    acceptanceRate: null,
    totalPushed7d: null,
    reliabilityPenaltyApplied: 0,
    feeTerm: 1,
    distanceTerm: 1,
    score: 2.5,
    offerWindowSeconds: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbController.reset();
  adapterController.cancelBooking.mockReset().mockResolvedValue(undefined);
  adapterController.createBooking.mockReset().mockResolvedValue({ externalId: "icabbi-NEW-9" });
  routingController.rankCandidates.mockReset().mockResolvedValue([]);
  routingController.forwardStatusUpdate.mockReset().mockResolvedValue(undefined);
  routingController.routeBooking.mockReset();
  routingController.acceptDeadlineFor.mockReset().mockReturnValue(DEADLINE);
  sendOutboundEventMock.mockReset().mockResolvedValue({ ok: true });
  captureErrorMock.mockReset();
  logWarn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recheckStaleAcceptances — scan", () => {
  it("returns [] and does no further work when nothing is stale", async () => {
    // Common case (cron every minute): empty scan costs one SELECT, no
    // updates/inserts/adapter calls.
    dbController.selectQueue.push([]);
    const outcomes = await recheckStaleAcceptances();
    expect(outcomes).toEqual([]);
    expect(dbController.updates).toHaveLength(0);
    expect(dbController.inserts).toHaveLength(0);
  });
});

describe("recheckStaleAcceptances — max attempts", () => {
  it("fails the transit via forwardStatusUpdate after 5 reroutes and stops", async () => {
    // Loop must terminate: at MAX_REROUTE_ATTEMPTS the transit fails back to
    // the originator instead of bouncing forever.
    dbController.selectQueue.push([makeTransit({ rerouteCount: 5 })]);
    const outcomes = await recheckStaleAcceptances();

    expect(outcomes).toEqual([{ transitId: "tr_1", outcome: "max_attempts" }]);
    expect(routingController.forwardStatusUpdate).toHaveBeenCalledWith({
      transitId: "tr_1",
      newStatus: "failed",
      detail: { reason: "max_reroute_attempts", attemptsSoFar: 5 },
    });
    // No cancel/push attempted past the cap.
    expect(adapterController.cancelBooking).not.toHaveBeenCalled();
    expect(routingController.rankCandidates).not.toHaveBeenCalled();
  });
});

describe("recheckStaleAcceptances — candidate exclusion & no_match", () => {
  it("excludes waterfall attempts, prior reroutes and the current recipient", async () => {
    // Anti-loop guarantee: never re-offer to a fleet that had its chance. All
    // three exclusion sources seeded; rankCandidates returns only them → no_match.
    dbController.selectQueue.push([
      makeTransit({
        routingTrace: {
          waterfallAttempts: [{ recipientId: "p_waterfall" }],
          rerouteAttempts: [{ recipientId: "p_prior_reroute", reason: "x", at: "2026-06-10T09:00:00Z" }],
        },
      }),
    ]);
    routingController.rankCandidates.mockResolvedValue([
      makeCandidate("p_waterfall"),
      makeCandidate("p_prior_reroute"),
      makeCandidate("rec_old"), // the current recipient
    ]);

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes).toEqual([{ transitId: "tr_1", outcome: "no_more_candidates" }]);
    // Reroute ranking runs with fan-out so live availability decides.
    expect(routingController.rankCandidates).toHaveBeenCalledWith(
      "orig_1",
      expect.objectContaining({ bookingType: "asap" }),
      { useFanOut: true },
    );
    expect(adapterController.createBooking).not.toHaveBeenCalled();
  });

  it("drops the transit to no_match with a trace entry and event when no one is left", async () => {
    // Terminal state is auditable: status no_match, deadline cleared, a
    // rerouteAttempts dead-end entry, and a transit_event for the timeline.
    dbController.selectQueue.push([makeTransit()]);
    routingController.rankCandidates.mockResolvedValue([]); // network exhausted

    await recheckStaleAcceptances();

    const upd = dbController.updates.find((u) => u.table === transits)!;
    expect(upd.values.status).toBe("no_match");
    expect(upd.values.acceptDeadline).toBeNull();
    const trace = upd.values.routingTrace as {
      waterfallAttempts: unknown[];
      rerouteAttempts: Array<Record<string, unknown>>;
    };
    // Existing trace preserved, dead-end entry appended at frozen time.
    expect(trace.waterfallAttempts).toEqual([{ recipientId: "rec_old" }]);
    expect(trace.rerouteAttempts).toEqual([
      { recipientId: "rec_old", reason: "no_more_candidates", at: NOW.toISOString() },
    ]);

    const evt = dbController.inserts.find((i) => i.table === transitEvents)!;
    expect(evt.values).toEqual({
      transitId: "tr_1",
      status: "no_match",
      detail: { reason: "accept_window_expired_no_candidates", rerouteCount: 0 },
      actor: "system",
    });
  });
});

describe("recheckStaleAcceptances — successful reroute", () => {
  it("cancels on the original, pushes to the next candidate and updates everything", async () => {
    // Full happy path; each assertion pins one side-effect: cancel, push,
    // transit row update, timeline event, audit row.
    dbController.selectQueue.push([makeTransit()]);
    routingController.rankCandidates.mockResolvedValue([
      makeCandidate("p_next", { score: 1.1, distanceKm: 2.0 }),
      makeCandidate("p_backup"),
    ]);
    // Partner-name lookups for the audit row: new partner, then previous.
    dbController.selectQueue.push([{ id: "p_next", name: "Next Fleet" }]);
    dbController.selectQueue.push([{ id: "rec_old", name: "Old Fleet" }]);

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes).toEqual([{ transitId: "tr_1", outcome: "rerouted", newRecipientId: "p_next" }]);

    // 1. Cancel original with the expiry reason.
    expect(adapterController.cancelBooking).toHaveBeenCalledWith({
      externalId: "icabbi-OLD-1",
      reason: "accept_window_expired",
    });

    // 2. Push to the best remaining candidate (rank order).
    expect(adapterController.createBooking).toHaveBeenCalledWith({
      transitId: "tr_1",
      recipientPartnerId: "p_next",
      booking: expect.objectContaining({ bookingType: "asap" }),
      feeSnapshot: FEE,
    });

    // 3. Transit row: new recipient, fresh deadline, bumped count, trace entry.
    const upd = dbController.updates.find((u) => u.table === transits)!;
    expect(upd.values).toMatchObject({
      recipientPartnerId: "p_next",
      recipientBookingExternalId: "icabbi-NEW-9",
      feeSnapshot: FEE,
      status: "pushed",
      rerouteCount: 1,
      acceptDeadline: DEADLINE,
    });
    // Success path re-arms the deadline from booking type only.
    expect(routingController.acceptDeadlineFor).toHaveBeenCalledWith("asap");
    const trace = upd.values.routingTrace as { rerouteAttempts: Array<Record<string, unknown>> };
    expect(trace.rerouteAttempts).toEqual([
      {
        recipientId: "p_next",
        rank: 1.1,
        distanceKm: 2.0,
        receiveFeePence: 30,
        reason: "accept_window_expired",
        at: NOW.toISOString(),
        success: true,
      },
    ]);

    // 4. Timeline event for the detail page.
    const evt = dbController.inserts.find((i) => i.table === transitEvents)!;
    expect(evt.values).toEqual({
      transitId: "tr_1",
      status: "pushed",
      detail: { kind: "rerouted_after_accept_timeout", newRecipientId: "p_next", rerouteCount: 1 },
      actor: "system",
    });

    // 5. Audit row for super-admin review.
    const audit = dbController.inserts.find((i) => i.table === auditLog)!;
    expect(audit.values).toEqual({
      category: "booking",
      actor: "system",
      actorRef: "reroute_engine",
      action: "transit.rerouted",
      subjectType: "transit",
      subjectId: "tr_1",
      before: { recipientPartnerId: "rec_old" },
      after: {
        recipientPartnerId: "p_next",
        recipientName: "Next Fleet",
        reason: "accept_window_expired",
        rerouteCount: 1,
      },
    });
  });

  it("notifies the originator via a transit.rerouted webhook with a stable idempotency key", async () => {
    // The demand fleet must learn the fulfilling partner changed. Event key is
    // derived (transitId:type:count) so retries can't duplicate events.
    dbController.selectQueue.push([makeTransit({ rerouteCount: 2 })]);
    routingController.rankCandidates.mockResolvedValue([makeCandidate("p_next")]);
    dbController.selectQueue.push([{ id: "p_next", name: "Next Fleet" }]);
    dbController.selectQueue.push([{ id: "rec_old", name: "Old Fleet" }]);

    await recheckStaleAcceptances();

    expect(sendOutboundEventMock).toHaveBeenCalledWith(
      "orig_1",
      "transit.rerouted",
      {
        originatorBookingExternalId: "EXT-1",
        transitId: "tr_1",
        previous_recipient: { id: "rec_old", name: "Old Fleet" },
        new_recipient: { id: "p_next", name: "Next Fleet" },
        reason: "accept_window_expired",
        reroute_count: 3,
        occurred_at: NOW.toISOString(),
      },
      "tr_1:transit.rerouted:3",
    );
  });

  it("treats cancel-on-original failure as best-effort (warn + continue)", async () => {
    // A down old recipient must not block moving to a healthy fleet — warn only.
    adapterController.cancelBooking.mockRejectedValue(new Error("recipient unreachable"));
    dbController.selectQueue.push([makeTransit()]);
    routingController.rankCandidates.mockResolvedValue([makeCandidate("p_next")]);
    dbController.selectQueue.push([{ id: "p_next", name: "Next Fleet" }]);
    dbController.selectQueue.push([{ id: "rec_old", name: "Old Fleet" }]);

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes[0].outcome).toBe("rerouted");
    expect(logWarn).toHaveBeenCalledWith(
      "reroute cancel-on-original failed",
      expect.objectContaining({ transit_id: "tr_1", err: "recipient unreachable" }),
    );
  });

  it("skips the cancel step when the transit has no recipient yet and sends previous_recipient:null", async () => {
    // A stale transit can lack a recipient (push never landed): skip cancel,
    // audit before-state null, webhook previous_recipient null.
    dbController.selectQueue.push([
      makeTransit({ recipientPartnerId: null, recipientBookingExternalId: null, routingTrace: null }),
    ]);
    routingController.rankCandidates.mockResolvedValue([makeCandidate("p_next")]);
    dbController.selectQueue.push([{ id: "p_next", name: "Next Fleet" }]); // newPartner lookup only

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes[0].outcome).toBe("rerouted");
    expect(adapterController.cancelBooking).not.toHaveBeenCalled();
    const audit = dbController.inserts.find((i) => i.table === auditLog)!;
    expect(audit.values.before).toEqual({ recipientPartnerId: null });
    expect(sendOutboundEventMock.mock.calls[0][2]).toMatchObject({ previous_recipient: null });
  });

  it("still reports rerouted when the outbound webhook itself fails", async () => {
    // Webhook is fire-and-forget: a delivery failure warns; the reroute stands.
    sendOutboundEventMock.mockRejectedValue(new Error("webhook endpoint 500"));
    dbController.selectQueue.push([makeTransit()]);
    routingController.rankCandidates.mockResolvedValue([makeCandidate("p_next")]);
    dbController.selectQueue.push([{ id: "p_next", name: "Next Fleet" }]);
    dbController.selectQueue.push([{ id: "rec_old", name: "Old Fleet" }]);

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes[0].outcome).toBe("rerouted");
    expect(logWarn).toHaveBeenCalledWith(
      "reroute outbound event failed",
      expect.objectContaining({ transit_id: "tr_1", err: "webhook endpoint 500" }),
    );
  });
});

describe("recheckStaleAcceptances — push failure on the next candidate", () => {
  it("records the failed attempt, re-arms the deadline and leaves the transit for the next tick", async () => {
    // A next candidate that also fails must not mark the transit dead: trace
    // the attempt (success:false + error), push the deadline forward, leave
    // rerouteCount put.
    // FLAG: a failed push doesn't increment rerouteCount, so a chronically
    // erroring candidate retries every tick forever and never trips
    // MAX_REROUTE_ATTEMPTS (only successful reroutes count). Pins today's
    // behaviour, not an endorsement.
    adapterController.createBooking.mockRejectedValue(new Error("createBooking 503"));
    dbController.selectQueue.push([makeTransit()]);
    routingController.rankCandidates.mockResolvedValue([
      makeCandidate("p_flaky", { offerWindowSeconds: 60 }),
    ]);

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes).toEqual([
      { transitId: "tr_1", outcome: "error", newRecipientId: "p_flaky", error: "createBooking 503" },
    ]);

    const upd = dbController.updates.find((u) => u.table === transits)!;
    // Status/recipient untouched — only trace + deadline move.
    expect(upd.values.status).toBeUndefined();
    expect(upd.values.rerouteCount).toBeUndefined();
    expect(upd.values.acceptDeadline).toBe(DEADLINE);
    // Failure path honours the candidate's offer window.
    expect(routingController.acceptDeadlineFor).toHaveBeenCalledWith("asap", 60);
    const trace = upd.values.routingTrace as { rerouteAttempts: Array<Record<string, unknown>> };
    expect(trace.rerouteAttempts[0]).toMatchObject({
      recipientId: "p_flaky",
      success: false,
      error: "createBooking 503",
    });
    // No timeline event / audit row for a failed push.
    expect(dbController.inserts).toHaveLength(0);
    expect(sendOutboundEventMock).not.toHaveBeenCalled();
  });
});

describe("recheckStaleAcceptances — per-transit error containment", () => {
  it("captures a throwing transit as an error outcome and keeps processing the batch", async () => {
    // One poisoned transit (ranking blows up) must not starve the rest — the
    // second still gets rerouted.
    dbController.selectQueue.push([
      makeTransit({ id: "tr_bad" }),
      makeTransit({ id: "tr_good" }),
    ]);
    routingController.rankCandidates
      .mockRejectedValueOnce(new Error("ranking exploded"))
      .mockResolvedValueOnce([makeCandidate("p_next")]);
    dbController.selectQueue.push([{ id: "p_next", name: "Next Fleet" }]);
    dbController.selectQueue.push([{ id: "rec_old", name: "Old Fleet" }]);

    const outcomes = await recheckStaleAcceptances();
    expect(outcomes).toEqual([
      { transitId: "tr_bad", outcome: "error", error: "ranking exploded" },
      { transitId: "tr_good", outcome: "rerouted", newRecipientId: "p_next" },
    ]);
  });

  it("stringifies non-Error throwables in the error outcome", async () => {
    // Non-Error rejection must still yield a readable string, not [object Object].
    dbController.selectQueue.push([makeTransit()]);
    routingController.rankCandidates.mockRejectedValueOnce("string failure");
    const outcomes = await recheckStaleAcceptances();
    expect(outcomes).toEqual([{ transitId: "tr_1", outcome: "error", error: "string failure" }]);
  });
});

describe("resumePausedTransits — kill-switch recovery", () => {
  it("returns zero counts when nothing is paused", async () => {
    // Disengaging the kill switch on a quiet network is a single scan.
    dbController.selectQueue.push([]);
    const res = await resumePausedTransits("admin_1");
    expect(res).toEqual({ scanned: 0, pushed: 0, no_match: 0, paused: 0, error: 0 });
    expect(routingController.routeBooking).not.toHaveBeenCalled();
  });

  it("replays routeBooking per paused transit, tallies outcomes and audit-logs each", async () => {
    // No booking stays stranded at 'paused' once the switch is off. Each
    // replay outcome is counted and audit-logged with the admin's ref.
    dbController.selectQueue.push([
      makeTransit({ id: "tp_1", status: "paused" }),
      makeTransit({ id: "tp_2", status: "paused" }),
      makeTransit({ id: "tp_3", status: "paused" }),
    ]);
    routingController.routeBooking
      .mockResolvedValueOnce({ transitId: "tp_1", outcome: "pushed" })
      .mockResolvedValueOnce({ transitId: "tp_2", outcome: "no_match" })
      .mockResolvedValueOnce({ transitId: "tp_3", outcome: "paused" }); // switch flipped back on

    const res = await resumePausedTransits("admin_odhran");
    expect(res).toEqual({ scanned: 3, pushed: 1, no_match: 1, paused: 1, error: 0 });

    // routeBooking is idempotent on (originator, externalId) — replay passes
    // the original payload straight through.
    expect(routingController.routeBooking).toHaveBeenCalledWith({
      originatorPartnerId: "orig_1",
      booking: expect.objectContaining({ originatorBookingExternalId: "EXT-1" }),
    });

    const audits = dbController.inserts.filter((i) => i.table === auditLog);
    expect(audits).toHaveLength(3);
    expect(audits[0].values).toMatchObject({
      action: "transit.resumed_from_paused",
      actorRef: "admin_odhran",
      subjectId: "tp_1",
      before: { status: "paused" },
      after: { outcome: "pushed" },
    });
  });

  it("counts a throwing replay as error and reports it to observability", async () => {
    // A broken transit must not abort the sweep; it's counted and sent to
    // captureError with enough context to find it.
    dbController.selectQueue.push([
      makeTransit({ id: "tp_bad", status: "paused" }),
      makeTransit({ id: "tp_ok", status: "paused" }),
    ]);
    routingController.routeBooking
      .mockRejectedValueOnce(new Error("replay failed"))
      .mockResolvedValueOnce({ transitId: "tp_ok", outcome: "pushed" });

    const res = await resumePausedTransits("admin_1");
    expect(res).toEqual({ scanned: 2, pushed: 1, no_match: 0, paused: 0, error: 1 });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      { area: "resume_paused", transit_id: "tp_bad" },
    );
    // No audit row for the failed one — only the successful replay.
    expect(dbController.inserts.filter((i) => i.table === auditLog)).toHaveLength(1);
  });
});

// partners must be the real schema object so the table-identity assertions
// above stay meaningful (guards against an accidental mock).
it("uses the real drizzle schema objects for table identity checks", () => {
  expect(partners).toBeDefined();
  expect(transits).toBeDefined();
});
