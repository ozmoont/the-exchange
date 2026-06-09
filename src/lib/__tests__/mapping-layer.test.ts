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
 * H2 Mapping Layer (Epic 3) — locks the behaviour of applyMapping +
 * reverseMapping against the BDD spec's FreeNow worked example and the
 * supported transformation taxonomy.
 *
 * NFR target: <50ms per call. Tests don't assert timing (Vitest's CI
 * timing isn't deterministic enough) but every transformation is local
 * computation so timing is dominated by JS overhead.
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
    // Unknown vehicle type passed through unchanged + warning logged
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
    // dropoff was unmapped (no required: true) → no dest_latitude etc.
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

    // Second read with garbage input should still return the cached one
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
    // A is gone from cache → next load reflects fresh input
    expect(loadMappingConfig("A", null)).toBeNull();
    // B is still cached → null input returns the original
    expect(loadMappingConfig("B", null)?.fields["y"]).toBeDefined();
  });
});
