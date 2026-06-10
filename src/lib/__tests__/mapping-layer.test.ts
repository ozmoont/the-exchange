import { describe, expect, it } from "vitest";
import {
  applyMapping,
  reverseMapping,
  getByPath,
  setByPath,
  loadMappingConfig,
  clearMappingCache,
  type MappingConfig,
} from "@/lib/mapping-layer";

/**
 * H2 Mapping Layer (Epic 3): applyMapping + reverseMapping against the BDD
 * spec's FreeNow worked example and the transformation taxonomy. (<50ms NFR
 * not asserted — CI timing isn't deterministic; all transforms are local.)
 */

const freenowConfig: MappingConfig = {
  fields: {
    "pickup.lat":          { partner_field: "latitude", required: true },
    "pickup.lng":          { partner_field: "longitude", required: true },
    "pickup.address":      { partner_field: "pickup_address" },
    "dropoff.lat":         { partner_field: "dest_latitude" },
    "dropoff.lng":         { partner_field: "dest_longitude" },
    "dropoff.address":     { partner_field: "dest_address" },
    "vehicle_type": {
      partner_field:       "service_class",
      value_lookup:        { saloon: "ECO", exec: "BUSINESS", mpv: "VAN" },
    },
    "eta_minutes": {
      partner_field:       "eta_seconds",
      transform:           { type: "multiply", value: 60 },
    },
    "passenger.name":      { partner_field: "customer_name" },
    "passenger.phone":     { partner_field: "customer_mobile" },
    "passenger.count":     { partner_field: "pax_count" },
    "fare.amount": {
      partner_field:       "total_pence",
      transform:           { type: "multiply", value: 100 },
    },
    "fare.currency":       { partner_field: "currency_code" },
    "booking.id":          { partner_field: "job_id" },
    "booking.status": {
      partner_field:       "job_status",
      value_lookup_reverse: {
        ACCEPTED:          "Accepted",
        DRIVER_ASSIGNED:   "Driver Assigned",
        IN_PROGRESS:       "Passenger On Board",
        COMPLETED:         "Completed",
      },
    },
  },
  endpoints: {
    create_booking: "https://freenow.example/bookings",
  },
};

describe("applyMapping — emit canonical → partner shape", () => {
  it("renames direct fields (BDD FreeNow worked example)", () => {
    const canonical = {
      pickup: { lat: 51.507, lng: -0.128, address: "Trafalgar Square" },
      dropoff: { lat: 51.47, lng: -0.454, address: "Heathrow T5" },
      vehicle_type: "saloon",
      passenger: { name: "Jane Doe", phone: "+447700900000", count: 1 },
    };
    const r = applyMapping(canonical, freenowConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.latitude).toBe(51.507);
    expect(r.payload.longitude).toBe(-0.128);
    expect(r.payload.pickup_address).toBe("Trafalgar Square");
    expect(r.payload.dest_latitude).toBe(51.47);
    expect(r.payload.dest_address).toBe("Heathrow T5");
    expect(r.payload.customer_name).toBe("Jane Doe");
    expect(r.payload.customer_mobile).toBe("+447700900000");
    expect(r.payload.pax_count).toBe(1);
  });

  it("applies value_lookup for vehicle_type (saloon → ECO)", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, vehicle_type: "saloon" },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.service_class).toBe("ECO");
  });

  it("applies value_lookup for exec → BUSINESS", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, vehicle_type: "exec" },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.service_class).toBe("BUSINESS");
  });

  it("emits multiply transform — eta_minutes 5 → eta_seconds 300", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, eta_minutes: 5 },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.eta_seconds).toBe(300);
  });

  it("emits multiply transform — fare.amount £42.50 → 4250 pence", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, fare: { amount: 42.5 } },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.total_pence).toBe(4250);
  });

  it("returns missing when a required field has no value", () => {
    const r = applyMapping({ pickup: { lng: -0.1 } }, freenowConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toContain("pickup.lat");
  });

  it("warns when value_lookup has no entry but still emits the raw value", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, vehicle_type: "limo_xl" },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Unknown vehicle type passed through unchanged + warning.
    expect(r.payload.service_class).toBe("limo_xl");
    expect(r.warnings.some((w) => w.includes("vehicle_type"))).toBe(true);
  });

  it("omits unmapped optional canonical fields without complaint", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, passenger: { name: "Jane" } },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // dropoff unmapped (not required) → no dest_latitude etc.
    expect(r.payload.dest_latitude).toBeUndefined();
  });

  it("warns when transform encounters a non-number", () => {
    const r = applyMapping(
      { pickup: { lat: 51.5, lng: -0.1 }, eta_minutes: "five" as unknown as number },
      freenowConfig,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes("eta_minutes"))).toBe(true);
  });
});

describe("reverseMapping — receive partner → canonical", () => {
  it("recovers basic fields from a partner response", () => {
    const partner = {
      latitude: 51.507,
      longitude: -0.128,
      customer_name: "Jane Doe",
      pax_count: 2,
    };
    const r = reverseMapping(partner, freenowConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getByPath(r.canonical, "pickup.lat")).toBe(51.507);
    expect(getByPath(r.canonical, "pickup.lng")).toBe(-0.128);
    expect(getByPath(r.canonical, "passenger.name")).toBe("Jane Doe");
    expect(getByPath(r.canonical, "passenger.count")).toBe(2);
  });

  it("reverses a multiply transform — eta_seconds 300 → eta_minutes 5", () => {
    const r = reverseMapping({ eta_seconds: 300 }, freenowConfig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical.eta_minutes).toBe(5);
  });

  it("reverses fare transform — total_pence 4250 → fare.amount 42.5", () => {
    const r = reverseMapping({ total_pence: 4250 }, freenowConfig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(getByPath(r.canonical, "fare.amount")).toBe(42.5);
  });

  it("inverts a forward value_lookup — ECO → saloon", () => {
    const r = reverseMapping({ service_class: "ECO" }, freenowConfig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical.vehicle_type).toBe("saloon");
  });

  it("uses value_lookup_reverse — IN_PROGRESS → Passenger On Board", () => {
    const r = reverseMapping({ job_status: "IN_PROGRESS" }, freenowConfig);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(getByPath(r.canonical, "booking.status")).toBe("Passenger On Board");
    }
  });

  it("warns + passes through on unknown partner enum values", () => {
    const r = reverseMapping({ service_class: "PREMIUM_PLUS" }, freenowConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canonical.vehicle_type).toBe("PREMIUM_PLUS");
    expect(r.warnings.some((w) => w.includes("vehicle_type"))).toBe(true);
  });
});

describe("round-trip", () => {
  it("survives apply → reverse with no data loss for simple fields", () => {
    const canonical = {
      pickup: { lat: 51.507, lng: -0.128, address: "Trafalgar Square" },
      vehicle_type: "saloon",
      eta_minutes: 5,
      fare: { amount: 42.5 },
      passenger: { name: "Jane", phone: "+44" },
    };
    const out = applyMapping(canonical, freenowConfig);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const back = reverseMapping(out.payload, freenowConfig);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(getByPath(back.canonical, "pickup.lat")).toBe(51.507);
    expect(back.canonical.vehicle_type).toBe("saloon");
    expect(back.canonical.eta_minutes).toBe(5);
    expect(getByPath(back.canonical, "fare.amount")).toBe(42.5);
  });
});

describe("path helpers", () => {
  it("getByPath returns undefined for missing intermediates", () => {
    expect(getByPath({}, "a.b.c")).toBeUndefined();
    expect(getByPath({ a: 1 }, "a.b")).toBeUndefined();
  });

  it("setByPath builds intermediate objects", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "a.b.c", 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });
});

describe("config cache", () => {
  it("caches normalised config on first read", () => {
    clearMappingCache();
    const cfg = loadMappingConfig("partner-A", {
      fields: {
        "pickup.lat": { partner_field: "lat" },
      },
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.fields["pickup.lat"]?.partner_field).toBe("lat");

    // Second read with garbage input still returns the cached config.
    const cached = loadMappingConfig("partner-A", null);
    expect(cached?.fields["pickup.lat"]?.partner_field).toBe("lat");
  });

  it("returns null for partners with no mapping configured", () => {
    clearMappingCache();
    expect(loadMappingConfig("partner-B", null)).toBeNull();
    expect(loadMappingConfig("partner-C", { wrong: "shape" })).toBeNull();
  });

  it("clearMappingCache(partnerId) only invalidates one", () => {
    clearMappingCache();
    loadMappingConfig("A", { fields: { x: { partner_field: "X" } } });
    loadMappingConfig("B", { fields: { y: { partner_field: "Y" } } });
    clearMappingCache("A");
    // A evicted → fresh input (null) returns null.
    expect(loadMappingConfig("A", null)).toBeNull();
    // B still cached → null input returns the original.
    expect(loadMappingConfig("B", null)?.fields["y"]).toBeDefined();
  });
});

// APPENDED — coverage closure for the H2 engine (formatting, transforms,
// endpoint resolution, config normalisation).

// Duplicate ESM imports are legal; appended to keep the original block untouched.
import { resolveEndpoint } from "@/lib/mapping-layer";
import { log } from "@/lib/logger";
import { vi } from "vitest";

/** Build a one-field config around a format_datetime transform. */
function dtConfig(format: string, tz?: string): MappingConfig {
  return {
    fields: {
      "booking.scheduled_at": {
        partner_field: "pickup_time",
        transform: { type: "format_datetime", format, ...(tz ? { tz } : {}) },
      },
    },
  };
}

/** Emit a single scheduled_at value through a dtConfig and return the wire string. */
function emitDt(value: unknown, format: string, tz?: string) {
  const r = applyMapping({ booking: { scheduled_at: value } }, dtConfig(format, tz));
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  return { wire: r.payload.pickup_time, warnings: r.warnings };
}

describe("format_datetime transform — emit (CMAC-style local-time wire dates)", () => {
  it('renders "yyyy-MM-dd HH:mm" in Europe/London (BST offset applied, no TZ marker)', () => {
    // The CMAC requirement: ISO UTC in, local wall-clock out, no tz suffix.
    // July = BST = +1h.
    const { wire } = emitDt("2026-07-15T13:45:30Z", "yyyy-MM-dd HH:mm", "Europe/London");
    expect(wire).toBe("2026-07-15 14:45");
  });

  it("uses GMT (no offset) for winter dates in Europe/London", () => {
    // DST: the same config flips offsets with the calendar (else winter
    // prebooks land an hour late).
    const { wire } = emitDt("2026-01-15T13:45:00Z", "yyyy-MM-dd HH:mm", "Europe/London");
    expect(wire).toBe("2026-01-15 13:45");
  });

  it("defaults to UTC when no tz is configured", () => {
    const { wire } = emitDt("2026-07-15T13:45:30Z", "yyyy-MM-dd HH:mm");
    expect(wire).toBe("2026-07-15 13:45");
  });

  it('supports the seconds variant "yyyy-MM-dd HH:mm:ss"', () => {
    const { wire } = emitDt("2026-07-15T13:45:30Z", "yyyy-MM-dd HH:mm:ss");
    expect(wire).toBe("2026-07-15 13:45:30");
  });

  it('supports the T-separated "yyyy-MM-ddTHH:mm"', () => {
    const { wire } = emitDt("2026-07-15T13:45:30Z", "yyyy-MM-ddTHH:mm");
    expect(wire).toBe("2026-07-15T13:45");
  });

  it('supports "yyyy-MM-ddTHH:mm:ss" with a timezone applied', () => {
    const { wire } = emitDt("2026-07-15T13:45:30Z", "yyyy-MM-ddTHH:mm:ss", "Europe/London");
    expect(wire).toBe("2026-07-15T14:45:30");
  });

  it('supports the UK-style "dd/MM/yyyy HH:mm"', () => {
    const { wire } = emitDt("2026-07-15T13:45:30Z", "dd/MM/yyyy HH:mm", "Europe/London");
    expect(wire).toBe("15/07/2026 14:45");
  });

  it("accepts a Date instance, not just an ISO string", () => {
    // Engine accepts string-or-Date — lock the Date branch.
    const { wire } = emitDt(new Date("2026-07-15T13:45:00Z"), "yyyy-MM-dd HH:mm");
    expect(wire).toBe("2026-07-15 13:45");
  });

  it('renders midnight as "00", never Intl\'s "24" (the hour-24 remap guard)', () => {
    // Intl en-GB hour12:false can yield "24" for midnight — "24:05" breaks
    // partner-side parsers, so the engine remaps to "00".
    const { wire } = emitDt("2026-06-10T00:05:00Z", "yyyy-MM-dd HH:mm");
    expect(wire).toBe("2026-06-10 00:05");
  });

  it("warns and passes the raw value through when the date is unparseable", () => {
    // Best-effort: a garbage date doesn't block the booking — raw value out
    // + a warning.
    const { wire, warnings } = emitDt("not-a-date", "yyyy-MM-dd HH:mm");
    expect(wire).toBe("not-a-date");
    expect(warnings.some((w) => w.includes("format_datetime") && w.includes("cannot parse"))).toBe(true);
  });

  it("warns and passes through on an unsupported format token", () => {
    // Deliberate token whitelist (no date-fns dep): a config typo degrades to
    // passthrough + warning, not a crash.
    const { wire, warnings } = emitDt("2026-07-15T13:45:00Z", "MM-dd-yy");
    expect(wire).toBe("2026-07-15T13:45:00Z");
    expect(warnings.some((w) => w.includes('unknown format "MM-dd-yy"'))).toBe(true);
  });

  it("receive direction is a pass-through (partners send dates in many shapes)", () => {
    // format_datetime is emit-only — reverse hands the raw value through.
    const r = reverseMapping({ pickup_time: "15/07/2026 14:45" }, dtConfig("dd/MM/yyyy HH:mm", "Europe/London"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getByPath(r.canonical, "booking.scheduled_at")).toBe("15/07/2026 14:45");
  });
});

describe("divide transform + inverse + zero guard", () => {
  // Pence → pounds on emit (divide 100), pounds → pence on receive.
  const divideConfig: MappingConfig = {
    fields: {
      "fare.pence": { partner_field: "pounds", transform: { type: "divide", value: 100 } },
    },
  };

  it("emits a divide transform — 4250 pence → 42.5 pounds", () => {
    const r = applyMapping({ fare: { pence: 4250 } }, divideConfig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.pounds).toBe(42.5);
  });

  it("inverts divide to multiply on receive — 42.5 pounds → 4250 pence", () => {
    // Symmetry: emit(receive(x)) == x for divide/multiply pairs.
    const r = reverseMapping({ pounds: 42.5 }, divideConfig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(getByPath(r.canonical, "fare.pence")).toBe(4250);
  });

  it("refuses a zero divisor and passes the value through unchanged (with a log)", () => {
    // A zero divisor would emit Infinity — the guard returns the raw value
    // and warns instead.
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const zeroConfig: MappingConfig = {
      fields: { amount: { partner_field: "amt", transform: { type: "divide", value: 0 } } },
    };
    const r = applyMapping({ amount: 500 }, zeroConfig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.amt).toBe(500); // unchanged, not Infinity
    expect(warnSpy).toHaveBeenCalledWith(
      "mapping-layer: refusing zero-division/multiplication",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("warns when the reverse transform receives a non-number", () => {
    // Partners may send numerics as strings ("42.50") — don't coerce silently;
    // warn and pass through so the caller sees what arrived.
    const r = reverseMapping({ pounds: "42.50" }, divideConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getByPath(r.canonical, "fare.pence")).toBe("42.50");
    expect(r.warnings.some((w) => w.includes('reverse transform "divide"'))).toBe(true);
  });
});

describe("reverse lookups — miss handling and ambiguity", () => {
  it("warns + passes through when value_lookup_reverse has no entry for the partner value", () => {
    // Receive-only table (booking.status) missing a partner status →
    // surface raw, logged (distinct from the forward-table inverse miss above).
    const r = reverseMapping({ job_status: "VANISHED" }, freenowConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getByPath(r.canonical, "booking.status")).toBe("VANISHED");
    expect(r.warnings.some((w) => w.includes("value_lookup_reverse miss"))).toBe(true);
  });

  it("keeps the FIRST canonical key when two map to the same partner value (deterministic inversion)", () => {
    // invertLookup keeps the first entry on ambiguous inversions (no flapping);
    // partners needing disambiguation use value_lookup_reverse.
    const ambiguous: MappingConfig = {
      fields: {
        vehicle_class: {
          partner_field: "cls",
          value_lookup: { saloon: "STD", estate: "STD" }, // both → "STD"
        },
      },
    };
    const r = reverseMapping({ cls: "STD" }, ambiguous);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical.vehicle_class).toBe("saloon"); // first key wins
  });

  it("stringifies numeric partner values before reverse lookup (CMAC status=1)", () => {
    // CMAC sends numeric status enums; the reverse table is string-keyed
    // (JS object constraint) — the engine bridges that.
    const numericStatus: MappingConfig = {
      fields: {
        "booking.status": {
          partner_field: "status",
          value_lookup_reverse: { "1": "received", "9": "driver_assigned" },
        },
      },
    };
    const r = reverseMapping({ status: 9 }, numericStatus);
    expect(r.ok).toBe(true);
    if (r.ok) expect(getByPath(r.canonical, "booking.status")).toBe("driver_assigned");
  });
});

describe("resolveEndpoint — URL/method/{external_id} templating", () => {
  it("returns null for an undefined spec (endpoint not configured)", () => {
    expect(resolveEndpoint(undefined)).toBeNull();
  });

  it("treats a plain string spec as POST with no templating", () => {
    // FreeNow-style string form — what most partners use.
    expect(resolveEndpoint("https://freenow.example/bookings")).toEqual({
      url: "https://freenow.example/bookings",
      method: "POST",
    });
  });

  it("substitutes ALL {external_id} occurrences with the URL-encoded id", () => {
    // g-flag + encodeURIComponent: "AB/12" mustn't break the path, and a
    // twice-used template must get the id twice.
    const r = resolveEndpoint(
      "https://p.example/jobs/{external_id}/audit/{external_id}",
      "AB/12",
    );
    expect(r).toEqual({
      url: "https://p.example/jobs/AB%2F12/audit/AB%2F12",
      method: "POST",
    });
  });

  it("honours an explicit method on the object form (CMAC DELETE /Jobs/{id})", () => {
    const r = resolveEndpoint(
      { url: "https://p.example/Jobs/{external_id}", method: "DELETE" },
      "778",
    );
    expect(r).toEqual({ url: "https://p.example/Jobs/778", method: "DELETE" });
  });

  it("defaults the object form to POST when no method is given", () => {
    expect(resolveEndpoint({ url: "https://p.example/q" })).toEqual({
      url: "https://p.example/q",
      method: "POST",
    });
  });

  it("leaves the {external_id} placeholder intact when no id is supplied", () => {
    // No-id resolution (e.g. create_booking) leaves the template intact —
    // substitution only happens when an id exists.
    const r = resolveEndpoint("https://p.example/jobs/{external_id}");
    expect(r?.url).toBe("https://p.example/jobs/{external_id}");
  });
});

describe("loadMappingConfig — normalisation of raw DB JSON", () => {
  it("preserves required/transform/value_lookup/value_lookup_reverse/endpoints through normalisation", () => {
    // Admin UI writes raw JSON; every optional facet must survive into a
    // typed config or partners lose transforms on save.
    clearMappingCache();
    const cfg = loadMappingConfig("partner-full", {
      fields: {
        "fare.amount": {
          partner_field: "price",
          required: true,
          transform: { type: "multiply", value: 100 },
          value_lookup: { a: 1 },
          value_lookup_reverse: { "1": "a" },
        },
      },
      endpoints: { quote: { url: "https://p/q", method: "GET" } },
    });
    expect(cfg).not.toBeNull();
    const f = cfg?.fields["fare.amount"];
    expect(f?.required).toBe(true);
    expect(f?.transform).toEqual({ type: "multiply", value: 100 });
    expect(f?.value_lookup).toEqual({ a: 1 });
    expect(f?.value_lookup_reverse).toEqual({ "1": "a" });
    expect(cfg?.endpoints?.quote).toEqual({ url: "https://p/q", method: "GET" });
  });

  it("drops malformed field entries (non-objects, missing partner_field, non-boolean required)", () => {
    // Garbage tolerance: one bad row mustn't poison the config — skip bad,
    // keep good.
    clearMappingCache();
    const cfg = loadMappingConfig("partner-messy", {
      fields: {
        good: { partner_field: "ok" },
        not_an_object: "nope",
        no_partner_field: { required: true },
        bad_required: { partner_field: "bf", required: "yes" }, // non-boolean → dropped
      },
    });
    expect(cfg).not.toBeNull();
    expect(Object.keys(cfg?.fields ?? {})).toEqual(["good", "bad_required"]);
    expect(cfg?.fields["bad_required"]?.required).toBeUndefined();
  });
});
