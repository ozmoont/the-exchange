import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  acceptDeadlineFor,
  ASAP_ACCEPT_WINDOW_MS,
  PREBOOK_ACCEPT_WINDOW_MS,
} from "@/lib/routing";

/**
 * Tier-1 #1 — partner offer window. Behaviour we lock in:
 *
 *   1. No recipient window → fall back to booking-type defaults (90s ASAP /
 *      5min pre-book). Pre-existing behaviour, must not regress.
 *   2. Recipient window between MIN_OFFER_WINDOW_S (15) and
 *      MAX_OFFER_WINDOW_S (1800) → use that value exactly.
 *   3. Recipient window below the floor or non-finite → fall back to
 *      booking-type defaults.
 *   4. Recipient window above the ceiling → clamp to 1800s.
 */
describe("acceptDeadlineFor", () => {
  const NOW = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses 90s for ASAP when no recipient window is set", () => {
    const d = acceptDeadlineFor("asap");
    expect(d.getTime() - NOW).toBe(ASAP_ACCEPT_WINDOW_MS);
  });

  it("uses 5min for pre-book when no recipient window is set", () => {
    const d = acceptDeadlineFor("prebook");
    expect(d.getTime() - NOW).toBe(PREBOOK_ACCEPT_WINDOW_MS);
  });

  it("uses null recipient window the same as undefined", () => {
    const d = acceptDeadlineFor("asap", null);
    expect(d.getTime() - NOW).toBe(ASAP_ACCEPT_WINDOW_MS);
  });

  it("honours a recipient window inside the clamp range", () => {
    const d = acceptDeadlineFor("asap", 45);
    expect(d.getTime() - NOW).toBe(45_000);
  });

  it("uses recipient window for pre-book bookings too (overrides type)", () => {
    const d = acceptDeadlineFor("prebook", 120);
    expect(d.getTime() - NOW).toBe(120_000);
  });

  it("clamps a too-high recipient window to MAX (1800s)", () => {
    const d = acceptDeadlineFor("asap", 99999);
    expect(d.getTime() - NOW).toBe(1800 * 1000);
  });

  it("falls back to booking-type default when recipient window is below MIN (15s)", () => {
    const d = acceptDeadlineFor("asap", 5);
    expect(d.getTime() - NOW).toBe(ASAP_ACCEPT_WINDOW_MS);
  });

  it("falls back when recipient window is NaN", () => {
    const d = acceptDeadlineFor("asap", NaN);
    expect(d.getTime() - NOW).toBe(ASAP_ACCEPT_WINDOW_MS);
  });

  it("falls back when recipient window is negative", () => {
    const d = acceptDeadlineFor("asap", -10);
    expect(d.getTime() - NOW).toBe(ASAP_ACCEPT_WINDOW_MS);
  });

  it("accepts exactly the MIN value (15s)", () => {
    const d = acceptDeadlineFor("asap", 15);
    expect(d.getTime() - NOW).toBe(15_000);
  });
});
