import { describe, expect, it } from "vitest";
import { normaliseICabbiInboundBooking } from "@/lib/icabbi-payload";

/**
 * H1.5 + canonical translation. Behaviour we lock in:
 *
 *   1. Required fields rejected with explicit missingFields list (no silent
 *      success on a partially-populated booking).
 *   2. Field-name tolerance — accept camelCase and snake_case variants,
 *      accept {latitude,longitude,formatted} as well as {lat,lng,address}.
 *   3. Canonical vehicle types translate at the wire boundary
 *      (saloon → standard, exec/executive → exec, mpv/minivan → mpv,
 *      wav/wheelchair → wav, van → van; unknown values pass through).
 *   4. PREBOOK booking_type requires scheduled_at.
 *   5. fare_estimate is converted from major-units decimal to pence integer.
 */
describe("normaliseICabbiInboundBooking", () => {
  const valid = {
    booking_id: "BK-001",
    booking_type: "ASAP",
    pickup: { lat: 51.507, lng: -0.128, address: "Trafalgar Square" },
    dropoff: { lat: 51.470, lng: -0.454, address: "Heathrow T5" },
    passenger: { name: "Jane Doe", phone: "+447700900000" },
    vehicle_type: "saloon",
  };

  it("normalises a minimal valid payload", () => {
    const r = normaliseICabbiInboundBooking(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.iCabbiBookingId).toBe("BK-001");
    expect(r.booking.pickup.lat).toBe(51.507);
    expect(r.booking.dropoff.lng).toBe(-0.454);
    expect(r.booking.passenger.name).toBe("Jane Doe");
    expect(r.booking.passenger.phone).toBe("+447700900000");
    expect(r.booking.passengerCount).toBe(1);
    expect(r.booking.bookingType).toBe("asap");
    // vehicle_type: saloon → standard (canonical translation)
    expect(r.booking.vehicleType).toBe("standard");
    expect(r.booking.channel).toBe("api");
  });

  it("translates each canonical vehicle type", () => {
    const cases: Array<[string, string]> = [
      ["saloon", "standard"],
      ["exec", "exec"],
      ["executive", "exec"],
      ["mpv", "mpv"],
      ["minivan", "mpv"],
      ["wav", "wav"],
      ["wheelchair", "wav"],
      ["van", "van"],
    ];
    for (const [canonical, internal] of cases) {
      const r = normaliseICabbiInboundBooking({ ...valid, vehicle_type: canonical });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.booking.vehicleType).toBe(internal);
    }
  });

  it("passes unknown vehicle types through unchanged", () => {
    const r = normaliseICabbiInboundBooking({ ...valid, vehicle_type: "limo_xl" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.booking.vehicleType).toBe("limo_xl");
  });

  it("accepts camelCase booking_type alias bookingType", () => {
    const r = normaliseICabbiInboundBooking({ ...valid, bookingType: "PREBOOK", scheduled_at: "2026-06-08T12:00:00Z" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.booking.bookingType).toBe("prebook");
      expect(r.booking.scheduledFor).toBe("2026-06-08T12:00:00Z");
    }
  });

  it("accepts latitude/longitude/formatted in pickup as field aliases", () => {
    const r = normaliseICabbiInboundBooking({
      ...valid,
      pickup: { latitude: 53.349, longitude: -6.262, formatted: "Dublin City Centre" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.booking.pickup.lat).toBe(53.349);
      expect(r.booking.pickup.lng).toBe(-6.262);
      expect(r.booking.pickup.address).toBe("Dublin City Centre");
    }
  });

  it("accepts customer_name / customer_phone as passenger aliases", () => {
    const { passenger, ...rest } = valid;
    void passenger;
    const r = normaliseICabbiInboundBooking({
      ...rest,
      customer_name: "Robert",
      customer_phone: "+447111222333",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.booking.passenger.name).toBe("Robert");
      expect(r.booking.passenger.phone).toBe("+447111222333");
    }
  });

  it("rejects with explicit missingFields when booking_id is absent", () => {
    const { booking_id, ...rest } = valid;
    void booking_id;
    const r = normaliseICabbiInboundBooking(rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_or_invalid_fields");
    expect(r.missingFields).toContain("booking_id");
    expect(r.status).toBe(400);
  });

  it("rejects when pickup lat is out of geographic range", () => {
    const r = normaliseICabbiInboundBooking({
      ...valid,
      pickup: { lat: 200, lng: -0.128, address: "X" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingFields).toContain("pickup.lat");
  });

  it("rejects PREBOOK without scheduled_at", () => {
    const r = normaliseICabbiInboundBooking({ ...valid, booking_type: "PREBOOK" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingFields?.some((f) => f.includes("scheduled_at"))).toBe(true);
  });

  it("converts decimal fare_estimate to pence integer", () => {
    const r = normaliseICabbiInboundBooking({ ...valid, fare_estimate: 42.5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.booking.fareEstimatePence).toBe(4250);
  });

  it("preserves the original payload under raw.original for audit", () => {
    const r = normaliseICabbiInboundBooking({ ...valid, custom_field: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.booking.raw as any).source).toBe("icabbi-inbound");
      expect((r.booking.raw as any).original.custom_field).toBe("x");
    }
  });
});
