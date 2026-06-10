import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fireJobs (src/lib/fire-jobs.ts) — load generator behind "Fire N jobs". Routes
 * every job through routeBooking() (the real-webhook path) and aggregates
 * outcomes. Locks in: empty network → zero/no-route; exactly `count` fired with
 * outcomes tallied; a throwing routeBooking counts as error, not a crash;
 * asapShare/execShare steer type+vehicle deterministically; prebook carries a
 * scheduledFor 1h out; the defensive hotspot fallback (unreachable with real
 * Math.random) forced via out-of-range Math.random. db+routing mocked.
 */

// db mock: fireJobs does one query — select active partners.
const dbController = {
  originators: [] as Array<Record<string, unknown>>,
};

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        // await db.select().from().where() — thenable, no .limit
        where: () => Promise.resolve(dbController.originators),
      }),
    }),
  },
}));

// routing mock: capture every booking routeBooking receives.
const routeBookingMock = vi.fn();
vi.mock("@/lib/routing", () => ({
  routeBooking: (...args: unknown[]) => routeBookingMock(...args),
}));

import { fireJobs, UK_HOTSPOTS } from "@/lib/fire-jobs";

const NOW = new Date("2026-06-10T09:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbController.originators = [{ id: "ptr_a", status: "active" }];
  routeBookingMock.mockReset();
  routeBookingMock.mockResolvedValue({ transitId: "t", outcome: "pushed" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fireJobs — empty network short-circuit", () => {
  it("returns an all-zero result and never routes when there are no active partners", async () => {
    // Empty network → clean no-op, not a crash or all-error batch.
    dbController.originators = [];
    const res = await fireJobs({ count: 5 });
    expect(res).toEqual({ attempted: 0, pushed: 0, no_match: 0, paused: 0, error: 0, elapsedMs: 0 });
    expect(routeBookingMock).not.toHaveBeenCalled();
  });
});

describe("fireJobs — outcome aggregation", () => {
  it("fires exactly `count` bookings and tallies each routeBooking outcome", async () => {
    // Summary drives the UI toast — each bucket reflects routeBooking's
    // result, attempted equals count.
    routeBookingMock
      .mockResolvedValueOnce({ transitId: "1", outcome: "pushed" })
      .mockResolvedValueOnce({ transitId: "2", outcome: "pushed" })
      .mockResolvedValueOnce({ transitId: "3", outcome: "no_match" })
      .mockResolvedValueOnce({ transitId: "4", outcome: "paused" })
      .mockResolvedValueOnce({ transitId: "5", outcome: "error" })
      .mockRejectedValueOnce(new Error("adapter exploded"));

    const res = await fireJobs({ count: 6 });
    expect(routeBookingMock).toHaveBeenCalledTimes(6);
    expect(res.attempted).toBe(6);
    expect(res.pushed).toBe(2);
    expect(res.no_match).toBe(1);
    expect(res.paused).toBe(1);
    // outcome:"error" result + the thrown call both land in `error`.
    expect(res.error).toBe(2);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("a throwing routeBooking is contained per-job (later jobs still fire)", async () => {
    // One bad booking can't abort the batch — workers catch per job.
    routeBookingMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ transitId: "x", outcome: "pushed" });
    const res = await fireJobs({ count: 3, concurrency: 1 });
    expect(res.error).toBe(1);
    expect(res.pushed).toBe(2);
  });

  it("count=0 fires nothing but still reports attempted=0", async () => {
    // Workers exit immediately on an empty queue.
    const res = await fireJobs({ count: 0 });
    expect(routeBookingMock).not.toHaveBeenCalled();
    expect(res.attempted).toBe(0);
  });

  it("respects a concurrency lower than count (all jobs still fire once)", async () => {
    // Worker-pool index handoff hands out each index exactly once.
    const res = await fireJobs({ count: 5, concurrency: 2 });
    expect(routeBookingMock).toHaveBeenCalledTimes(5);
    expect(res.attempted).toBe(5);
  });
});

describe("fireJobs — booking shape and share knobs", () => {
  it("builds a complete NormalisedBooking through the real-webhook path", async () => {
    // Synthetic jobs must look like real ones. Math.random=0 pins:
    // originator[0], first hotspot, exec, asap, min fare/passengers.
    vi.spyOn(Math, "random").mockReturnValue(0);
    await fireJobs({ count: 1, concurrency: 1 });

    const call = routeBookingMock.mock.calls[0][0] as {
      originatorPartnerId: string;
      booking: Record<string, unknown>;
    };
    expect(call.originatorPartnerId).toBe("ptr_a");
    const b = call.booking;
    expect(String(b.originatorBookingExternalId)).toMatch(/^UI-\d+-0-/);
    expect(b.bookingType).toBe("asap");
    expect(b.channel).toBe("api");
    expect(b.vehicleType).toBe("exec");
    expect(b.passengerCount).toBe(1);
    expect(b.fareEstimatePence).toBe(1000);
    expect(b.passenger).toEqual({ name: "Demo Passenger", phone: "+44 20 0000 0000" });
    expect(b.raw).toEqual({ source: "fire_jobs_ui" });
    expect(b.scheduledFor).toBeUndefined(); // ASAP carries no scheduledFor
    // Pickup: hotspot name as address, jittered coords near it.
    const pickup = b.pickup as { lat: number; lng: number; address: string };
    expect(pickup.address).toBe(UK_HOTSPOTS[0].name);
    expect(Math.abs(pickup.lat - UK_HOTSPOTS[0].lat)).toBeLessThan(0.1);
    expect(Math.abs(pickup.lng - UK_HOTSPOTS[0].lng)).toBeLessThan(0.1);
  });

  it("asapShare=0 produces prebook bookings with scheduledFor one hour out", async () => {
    // Prebook jobs carry the future timestamp routing needs; with fake
    // timers it's exactly now + 1h.
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 0.5 < 0 is false → prebook
    await fireJobs({ count: 1, concurrency: 1, asapShare: 0 });

    const b = (routeBookingMock.mock.calls[0][0] as { booking: Record<string, unknown> }).booking;
    expect(b.bookingType).toBe("prebook");
    expect(b.scheduledFor).toBe(new Date(NOW.getTime() + 3600_000).toISOString());
  });

  it("execShare=0 always produces standard vehicles", async () => {
    // Boundary: Math.random() < 0 is never true → always standard.
    vi.spyOn(Math, "random").mockReturnValue(0);
    await fireJobs({ count: 1, concurrency: 1, execShare: 0 });
    const b = (routeBookingMock.mock.calls[0][0] as { booking: Record<string, unknown> }).booking;
    expect(b.vehicleType).toBe("standard");
  });

  it("asapShare=1 always produces ASAP bookings", async () => {
    // Mirror boundary: Math.random() < 1 is always true → always asap.
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    await fireJobs({ count: 1, concurrency: 1, asapShare: 1 });
    const b = (routeBookingMock.mock.calls[0][0] as { booking: Record<string, unknown> }).booking;
    expect(b.bookingType).toBe("asap");
  });
});

describe("pickHotspot — defensive fallback", () => {
  it("falls back to the first hotspot if the weighted walk never lands (unreachable with real Math.random)", async () => {
    // FLAG (dead code in practice): pickHotspot's final return UK_HOTSPOTS[0]
    // is unreachable with real Math.random (the weighted walk always lands).
    // Forced via out-of-contract 1.5 to pin what the safety net returns.
    const rand = vi.spyOn(Math, "random");
    rand
      .mockReturnValueOnce(0) // originator pick → index 0 (in bounds)
      .mockReturnValueOnce(1.5) // pickup pickHotspot → walks off the end → fallback
      .mockReturnValue(0); // everything after: dropoff, jitter, shares, ids
    await fireJobs({ count: 1, concurrency: 1 });

    const b = (routeBookingMock.mock.calls[0][0] as { booking: Record<string, unknown> }).booking;
    expect((b.pickup as { address: string }).address).toBe(UK_HOTSPOTS[0].name);
  });
});
