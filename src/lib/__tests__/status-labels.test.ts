import { describe, expect, it } from "vitest";
import {
  STATUS_META,
  STATUSES_BY_GROUP,
  GROUP_LABEL,
  statusMeta,
  statusLabel,
  statusBadgeClass,
  type StatusGroup,
} from "@/lib/status-labels";

/**
 * Status → copy mapping (src/lib/status-labels.ts): single source of truth
 * for labels, badge tones, and the status→group mapping behind the
 * /bookings?status= filter. Locks in: known-code lookups, unknown→safe
 * fallback (no UI crash), tone→badge-class coverage, and STATUS_META ↔
 * STATUSES_BY_GROUP consistency (the likely regression: adding to one map only).
 */

describe("statusMeta", () => {
  it("returns the full meta for a known status code", () => {
    // Spot-check one core status (pushed shows on every dashboard) end-to-end.
    expect(statusMeta("pushed")).toEqual({
      label: "Sent to fleet",
      tone: "info",
      group: "in_flight",
      description: "Job pushed to a partner fleet, awaiting their acceptance.",
    });
  });

  it("returns the safe fallback for an unknown status code", () => {
    // DB enum can grow before this map does → render "Unknown", don't crash.
    expect(statusMeta("some_future_status")).toEqual({
      label: "Unknown",
      tone: "neutral",
      group: "in_flight",
      description: "Unknown status.",
    });
  });

  it("returns the fallback for the empty string", () => {
    // A blank/missing status renders the fallback too.
    expect(statusMeta("").label).toBe("Unknown");
  });
});

describe("statusLabel", () => {
  it("returns the label for known statuses", () => {
    // Label shorthand must agree with the full meta lookup.
    expect(statusLabel("completed")).toBe("Completed");
    expect(statusLabel("paused")).toBe("Paused (kill switch)");
    expect(statusLabel("error_auth")).toBe("Partner auth error");
  });

  it("returns 'Unknown' for unknown statuses", () => {
    expect(statusLabel("nope")).toBe("Unknown");
  });
});

describe("statusBadgeClass", () => {
  it("maps every tone to its matching badge class", () => {
    // One status per tone (every switch branch). Class names must exist in
    // globals.css — a rename here without a CSS change un-styles badges.
    expect(statusBadgeClass("completed")).toBe("badge-success"); // success
    expect(statusBadgeClass("cancelled")).toBe("badge-danger"); // danger
    expect(statusBadgeClass("paused")).toBe("badge-warning"); // warning
    expect(statusBadgeClass("routing")).toBe("badge-info"); // info
    expect(statusBadgeClass("received")).toBe("badge-neutral"); // neutral
  });

  it("falls back to badge-neutral for unknown statuses", () => {
    // Unknown → fallback meta (neutral) → neutral badge.
    expect(statusBadgeClass("whatever")).toBe("badge-neutral");
  });
});

describe("STATUS_META ↔ STATUSES_BY_GROUP consistency", () => {
  it("every status listed in STATUSES_BY_GROUP carries that same group in STATUS_META", () => {
    // /distribution stat cards filter by group; a wrong bucket shows the
    // wrong slice. Keeps the two hand-maintained maps from drifting.
    for (const [group, statuses] of Object.entries(STATUSES_BY_GROUP)) {
      for (const status of statuses) {
        expect(STATUS_META[status]?.group, `status '${status}' listed under group '${group}'`).toBe(group);
      }
    }
  });

  it("every STATUS_META status appears in exactly one group bucket", () => {
    // No orphans (meta but unreachable) and no duplicates (counted twice).
    const allGrouped = Object.values(STATUSES_BY_GROUP).flat();
    const metaKeys = Object.keys(STATUS_META);
    expect(allGrouped.sort()).toEqual(metaKeys.sort());
    expect(new Set(allGrouped).size).toBe(allGrouped.length);
  });

  it("GROUP_LABEL has a human label for every group key", () => {
    // A label-less group renders 'undefined' in the filter UI.
    const groups = Object.keys(STATUSES_BY_GROUP) as StatusGroup[];
    for (const g of groups) {
      expect(typeof GROUP_LABEL[g]).toBe("string");
      expect(GROUP_LABEL[g].length).toBeGreaterThan(0);
    }
  });

  it("every status has non-empty label and description copy", () => {
    // Guards a half-filled entry (label added, description forgotten).
    for (const [status, meta] of Object.entries(STATUS_META)) {
      expect(meta.label.length, `label for '${status}'`).toBeGreaterThan(0);
      expect(meta.description.length, `description for '${status}'`).toBeGreaterThan(0);
    }
  });
});
