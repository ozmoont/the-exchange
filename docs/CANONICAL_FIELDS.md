# Canonical Field Schema — Alignment Plan

*Locked per STRATEGY.md decision #14. Aligns our internal schema to the iCabbi BDD spec Section 4.1.*

## Why this doc exists

Two facts drive this:

1. The iCabbi BDD spec defines a canonical field schema (Section 4.1) that every partner mapping configuration must map to. It's the **shared internal language** of the broker.
2. Our `NormalisedBooking` type in `src/lib/types.ts` was built before that spec arrived. It's about 80% aligned but has casing and naming deltas that will bite us if we don't fix them.

This doc is the single source of truth for the canonical names we use internally **and** the names we expose on wire payloads to partners. New adapters and new outbound events use the canonical names from day one. Existing names migrate over time, without breaking the wire.

---

## Canonical field schema (the source of truth)

Matches iCabbi BDD spec Section 4.1 exactly. Any deviation must be documented here with a reason.

| Group | Canonical name | Type | Notes |
|---|---|---|---|
| **PRE** | `pickup.lat` | decimal (WGS84) | |
| | `pickup.lng` | decimal (WGS84) | |
| | `pickup.address` | string | full formatted address |
| | `dropoff.lat` | decimal (WGS84) | |
| | `dropoff.lng` | decimal (WGS84) | |
| | `dropoff.address` | string | |
| | `vehicle_type` | string enum | `saloon` \| `exec` \| `mpv` \| `wav` \| `van` |
| | `eta_minutes` | integer | runtime only — never persisted on the booking |
| **PASS** | `passenger.name` | string | |
| | `passenger.phone` | E.164 string | |
| | `passenger.count` | integer | |
| **FARE** | `fare.amount` | decimal | currency-major units (£12.50, not 1250p) |
| | `fare.currency` | ISO 4217 | GBP, EUR, USD |
| | `fare.breakdown` | object | nested cost / tip / extras / etc. Mirrors iCabbi `payment` object |
| **FEE** | `fee.tech` | decimal | appended by Exchange, not by partner |
| | `fee.booking` | decimal | appended by Exchange |
| | `fee.admin` | decimal | appended by Exchange |
| **BOOK** | `booking.id` | UUID string | our `transits.id` on outbound, recipient's id on inbound |
| | `booking.type` | enum | **uppercase**: `ASAP` \| `PREBOOK` |
| | `booking.scheduled_at` | ISO 8601 | set for PREBOOK only |
| | `booking.status` | enum | see status table below |
| **DRV** | `driver.name` | string | |
| | `driver.phone` | E.164 string | |
| | `driver.vehicle_reg` | string | |
| | `driver.location.lat` | decimal | |
| | `driver.location.lng` | decimal | |

---

## Status enum alignment

iCabbi's canonical status set is smaller than ours. Their set is what crosses the wire on outbound webhooks to non-iCabbi partners. Our internal enum keeps more granularity.

| Our internal | iCabbi canonical (wire) | Notes |
|---|---|---|
| `received` | — | internal only; never sent to a partner |
| `routing` | — | internal only |
| `no_match` | `Rejected` | sent as Rejected to inbound originator when exhausted |
| `pushed` | — | internal only; partner sees their own state |
| `accepted` | `Accepted` | direct map |
| `driver_assigned` | `Driver Assigned` | direct map |
| `driver_arrived` | `Driver En Route` | **iCabbi-specific event**; we collapse to Driver En Route on outbound to canonical partners. Internally preserved. |
| `en_route` | `Driver En Route` | direct map |
| `on_board` | `Passenger On Board` | direct map |
| `completed` | `Completed` | direct map |
| `cancelled` | `Cancelled` | direct map |
| `failed` | `Failed` | direct map |
| `paused` | — | internal kill-switch state, never sent |
| `error_auth` | `Failed` | collapsed with detail context |
| `error_other` | `Failed` | collapsed with detail context |

Implementation lives in `src/lib/status-labels.ts` (UI side) and `src/lib/icabbi-status-map.ts` (iCabbi-specific). We'll add `canonicalStatus()` helper to map `transits.status` → canonical wire value.

---

## Delta: our `NormalisedBooking` vs canonical

| Canonical | Our current field | Action |
|---|---|---|
| `pickup.lat`/`lng`/`address` | `pickup: { lat, lng, address }` | ✅ already aligned |
| `dropoff.lat`/`lng`/`address` | `dropoff: { lat, lng, address }` | ✅ already aligned |
| `vehicle_type` | `vehicleType: string` | 🟡 rename internal OR expose canonical at adapter boundary |
| `eta_minutes` | (computed at runtime in routing trace) | ✅ no persisted field needed |
| `passenger.name`/`phone` | `passenger: { name, phone }` | ✅ already aligned |
| `passenger.count` | `passengerCount: number` | 🟡 rename to `passenger.count` (nested) |
| `fare.amount` | `fareEstimatePence: number` | 🟡 internally pence (good for math, no float bugs); convert to decimal at wire |
| `fare.currency` | (assumed GBP everywhere) | 🔴 **add field** — required once we leave UK |
| `fare.breakdown` | (via `FeeSnapshot` + `BookingPaymentSummary`) | ✅ have the data, different shape |
| `fee.tech`/`booking`/`admin` | `FeeSnapshot.{tech,booking,admin}FeePence` | 🟡 rename to canonical at wire boundary |
| `booking.id` | `transits.id` (UUID) | ✅ already UUID |
| `booking.type` | `bookingType: "asap" \| "prebook"` | 🟡 **case difference** — internal lowercase, canonical uppercase. Translate at wire boundary |
| `booking.scheduled_at` | `scheduledFor?: string` | 🟡 rename or alias |
| `booking.status` | `transits.status` enum | 🟡 mapped via `canonicalStatus()` helper at wire boundary |
| `driver.*` | inside `transit_events.detail` jsonb | ✅ data exists; nested differently |

Legend: ✅ aligned · 🟡 needs translation at wire boundary · 🔴 needs schema/type addition

---

## Strategy: don't rename internals, translate at the boundary

Renaming `bookingType` to `booking.type` throughout the codebase touches ~30 files. That's expensive and risky pre-pilot. The cheaper move:

1. **Keep internal names as they are** (`bookingType`, `passengerCount`, `fareEstimatePence`, `vehicleType`).
2. **Build a `toCanonical(booking)` helper** in `src/lib/canonical.ts` that emits the canonical-shaped object for any outbound wire payload (status webhooks, booking creation calls to non-iCabbi partners, partner-facing API responses).
3. **Build a `fromCanonical(payload)` helper** for inbound — when a non-iCabbi partner sends us a booking using canonical names, normalise into our internal `NormalisedBooking`.
4. **New code** uses canonical names from day one (e.g. the future quote API, the future mapping layer).

This is the same pattern used in well-designed multi-vendor systems: internal name = whatever's ergonomic, wire name = canonical. The translation is a single chokepoint that's easy to test.

---

## What needs to change in code (small, surgical)

| Change | File | Effort |
|---|---|---|
| Add `fare.currency` field to `NormalisedBooking` (default "GBP") | `src/lib/types.ts` | trivial |
| Add `canonicalStatus()` helper | `src/lib/status-labels.ts` or new `src/lib/canonical.ts` | small |
| Add `toCanonical()` + `fromCanonical()` translators | new `src/lib/canonical.ts` | medium (~half a day) |
| Use `toCanonical()` in `src/lib/outbound-webhooks.ts` payload construction | `src/lib/outbound-webhooks.ts` | small |
| Document canonical names in `docs/IDEMPOTENCY.md` event payload section | `docs/IDEMPOTENCY.md` | small |

Schedule: H1.5 alongside virtual fleet registration. **Not pre-demo** — risk-free changes only until staging smoke is green.

---

## What doesn't change

- `transits.status` enum stays as-is internally. Canonical mapping is at the wire boundary.
- `FeeSnapshot` keeps pence for math safety. Canonical wire converts to decimal `fare.amount` + `fee.*`.
- Database column names stay as-is (`booking_type`, `passenger_count`, `fare_estimate_pence`). Renaming them requires migrations and breaks running queries for no real benefit.
- Existing adapters (`icabbi`, `mock_icabbi`) keep their internal field names. They translate to canonical via `toCanonical()` at the wire.

---

## Verification

When the canonical translators ship:

1. Property test: every `NormalisedBooking` round-trips through `toCanonical()` → `fromCanonical()` without loss.
2. Snapshot test: the outbound webhook payloads under `/webhooks` (P1-E1, P1-E2, etc.) match the canonical schema in this doc.
3. iCabbi-spec compliance test: feed the iCabbi BDD spec's worked FreeNow example into our mapping, confirm we emit a payload FreeNow would accept.

— Franko
