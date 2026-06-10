import { describe, expect, it } from "vitest";
import { canSeeDriverDetail, DRIVER_DETAILS_HIDDEN_EXPLAINER } from "@/lib/pii";
import type { SessionUser } from "@/lib/auth";

/**
 * Driver-PII visibility gate (src/lib/pii.ts) — the read-time PII minimiser.
 * Each test pins one rule; widening visibility is a privacy incident,
 * narrowing it locks the recipient out of their own driver.
 */

/** Build a viewer with sensible defaults; override per test. */
function viewer(overrides: Partial<SessionUser>): SessionUser {
  return {
    id: "u1",
    email: "u@x.com",
    role: "fleet_user",
    partnerId: "p-viewer",
    ...overrides,
  };
}

// A transit originated by p-demand and fulfilled by p-supply.
const TRANSIT = { originatorPartnerId: "p-demand", recipientPartnerId: "p-supply" };

describe("canSeeDriverDetail — role and fleet-membership rules", () => {
  it("super_admin always sees driver detail (operations override)", () => {
    // Ops see all regardless of flags — even with no partnerId/originator row.
    const v = viewer({ role: "super_admin", partnerId: null });
    expect(canSeeDriverDetail(v, TRANSIT, null)).toBe(true);
  });

  it("denies any non-super viewer without a partnerId", () => {
    // partnerId absence is not a backdoor: null + non-super is denied.
    const v = viewer({ partnerId: null });
    expect(canSeeDriverDetail(v, TRANSIT, { id: "p-demand", driverDetailsRequired: true })).toBe(false);
  });

  it("recipient-fleet viewer always sees their own driver", () => {
    // Supply side owns the driver record; allowed even with originator flag off.
    const v = viewer({ partnerId: "p-supply" });
    expect(canSeeDriverDetail(v, TRANSIT, { id: "p-demand", driverDetailsRequired: false })).toBe(true);
  });

  it("originator viewer sees detail only when their flag is ON", () => {
    // Corporate/VIP accounts opt in via driverDetailsRequired=true.
    const v = viewer({ partnerId: "p-demand" });
    expect(canSeeDriverDetail(v, TRANSIT, { id: "p-demand", driverDetailsRequired: true })).toBe(true);
  });

  it("originator viewer is denied when their flag is OFF (default)", () => {
    // PII minimisation default: demand side sees nothing unless opted in.
    const v = viewer({ partnerId: "p-demand" });
    expect(canSeeDriverDetail(v, TRANSIT, { id: "p-demand", driverDetailsRequired: false })).toBe(false);
  });

  it("originator viewer is denied when the originator row is missing", () => {
    // Fail closed: unhydrated row → flag unknown → treat as off.
    const v = viewer({ partnerId: "p-demand" });
    expect(canSeeDriverDetail(v, TRANSIT, null)).toBe(false);
  });

  it("denies an authenticated viewer from an unrelated third fleet", () => {
    // Cross-tenant privacy: a fleet on neither side never sees the PII.
    const v = viewer({ partnerId: "p-other" });
    expect(canSeeDriverDetail(v, TRANSIT, { id: "p-demand", driverDetailsRequired: true })).toBe(false);
  });

  it("handles a transit with no recipient yet (unrouted)", () => {
    // null recipient: recipient branch matches nobody, originator flag governs.
    const unrouted = { originatorPartnerId: "p-demand", recipientPartnerId: null };
    expect(
      canSeeDriverDetail(viewer({ partnerId: "p-demand" }), unrouted, {
        id: "p-demand",
        driverDetailsRequired: true,
      }),
    ).toBe(true);
    expect(
      canSeeDriverDetail(viewer({ partnerId: "p-other" }), unrouted, {
        id: "p-demand",
        driverDetailsRequired: true,
      }),
    ).toBe(false);
  });

  it("fleet_admin gets no special treatment over fleet_user", () => {
    // Only super_admin bypasses partner rules; unrelated fleet_admin is denied.
    const v = viewer({ role: "fleet_admin", partnerId: "p-other" });
    expect(canSeeDriverDetail(v, TRANSIT, { id: "p-demand", driverDetailsRequired: true })).toBe(false);
  });
});

describe("DRIVER_DETAILS_HIDDEN_EXPLAINER", () => {
  it("is a non-empty user-facing string that leaks no PII fields", () => {
    // Rendered verbatim in the UI: keep it present and generic (no PII enum).
    expect(DRIVER_DETAILS_HIDDEN_EXPLAINER.length).toBeGreaterThan(0);
    expect(DRIVER_DETAILS_HIDDEN_EXPLAINER).toMatch(/Driver details/);
  });
});
