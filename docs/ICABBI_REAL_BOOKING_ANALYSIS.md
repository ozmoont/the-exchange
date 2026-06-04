# Real iCabbi booking — analysis & implications

*Source: paired API responses for one cross-network booking, 2026-04-13.*

- **Demand fleet**: 247 CARZ BIRMINGHAM LTD (their `booking_id`: 60198532)
- **Supply fleet**: Direct Taxis / Take Me Taxi (their `booking_id`: 19282182)
- **Passenger**: NATALIE, 07473357746
- **Route**: 29 Ravenhurst Drive, Birmingham B43 → Apprentice Assessments Ltd, Walsall WS1
- **Fare**: £8.40 cash, fixed price
- **Driver**: Mizanur Rahman (DT173) in white Toyota Prius LW12DFY
- **Outcome**: COMPLETED, 3.29 km, 16 min driving

---

## The single most important finding

**iCabbi already has a partnership network protocol.**

The demand-side response contains a fully-formed `partnership_booking` object linking the two tenants:

```json
"partnership_booking": {
  "booking_id": 19282182,        // supply-side internal id
  "client_id": 30092,             // supply iCabbi tenant id
  "coid": "2661",                 // partnership chain id (cross-operator id)
  "site_id": 51,
  "original_site_id": "51",
  "server_name": "bounds",        // supply iCabbi cluster
  "status": "COMPLETED",
  "payment": { ... full mirrored payment block ... },
  "driver": { ... mirrored driver + vehicle ... },
  "track_my_taxi_link": "RJUNIL0X01.lc8.cab/w",
  "finish_status": "COMPLETED"
}
```

And `networking_status: { status: "COMPLETED" }` on the demand side, and the demand-side parent `status` is `TRANSFERRED` — meaning iCabbi knows this booking was handed to another tenant and is tracking its lifecycle natively.

**This means we need to be very deliberate about what The Exchange's value-add is.** The flow we've been building (originator pushes job → we route → recipient accepts) is roughly what iCabbi already does between two iCabbi tenants. If our pilot fleets are both on iCabbi, they could (in theory) connect to each other directly via iCabbi's native partnership network without us in the middle.

Three positions we can take. Sponsor needs to pick one before we build deeper:

1. **The Exchange replaces nothing iCabbi-to-iCabbi.** We exist purely to bridge iCabbi ↔ non-iCabbi (CMAC, Cordic, Autocab, Cabvision). iCabbi-on-both-ends bookings stay on iCabbi's rails.
2. **The Exchange sits on top of iCabbi's partnership protocol.** Routing intelligence, reliability scoring, multi-fleet auctioning, fees, audit — features iCabbi's direct partnership doesn't have. We use iCabbi's coid mechanism as our transport for iCabbi-on-both-ends pairs.
3. **The Exchange replaces iCabbi's partnership network entirely** for participating fleets. Higher value-add, much higher commercial conflict with iCabbi.

My read: **#2 is the realistic position.** iCabbi's partnership protocol moves bookings; The Exchange decides *which* partner gets a job, on what terms, with what reliability guarantees. iCabbi as transport, The Exchange as decision layer.

This needs to land in `STRATEGY.md` with a sponsor signature.

---

## Schema gaps in `NormalisedBooking`

The real iCabbi payload carries more than we currently capture. Most-impactful additions, in priority order:

| Field | Why it matters | Current state |
| --- | --- | --- |
| `vias[]` (multi-stop) | Real bookings have intermediate stops. Today our model is single pickup → single dropoff. | **Missing entirely** |
| `vehicle_type` / `vehicle_group` | Real values like `R4` / `Taxi`. Our `vehicleType: "standard" / "exec" / "wav"` is a simplification that won't match. | Need translation table |
| `attributegroup_id` | Compliance / accessibility flags (child seat, WAV, etc.). Routing must honour these. | **Missing** |
| `account_id` + `account` | Corporate account bookings have different fee / billing rules. | **Missing** |
| `payment.payment_type` / `payment.fixed` / `payment.tariff_id` | Cash / Card / Account, fixed-fare flag, tariff lookup. Affects fee snapshot. | Only `fareEstimatePence` captured |
| `payment.processing_fee` | Demand side declared £10 processing fee — needs reconciliation against our network fee | **Missing** |
| `flight_number` / `destination_flight_number` | Airport pickups need flight-tracking integration | **Missing** |
| `notes` / `instructions` / `driver_comment` | Passenger / dispatcher notes for the driver | **Missing** |
| `zone_id` / `zone.ref` | Operating zone within partner's network — finer-grained than our `operatingRegions` | **Missing** |
| `priority` | Urgency level — pre-bookings vs urgent ASAP | **Missing** |
| `route.actual` vs `route.estimate` | Distance + duration variance for post-trip analytics | **Missing** |
| `track_my_taxi_link` | Passenger tracking URL — we should pass this through | **Missing** |
| `CO2_emissions` | ESG reporting — partners may want this | **Missing** |
| `source` (APP / DISPATCH / etc.) | Where the booking originated — useful for analytics | **Missing** |

We don't need every field on day one. **Critical-path additions for pilot:** `vias[]` (multi-stop), `attributegroup_id` (compliance), `account_id` (corporate), `payment_type` + `tariff_id`, `notes` + `instructions`.

---

## Status mapping — explicit table needed

Real iCabbi statuses observed on the demand and supply sides don't map cleanly to our enum. We need a documented translation:

| iCabbi status | Our status | Notes |
| --- | --- | --- |
| `NEW` (payment.status) | n/a | Payment field, not booking field |
| `DISPATCHED` | `pushed` |  |
| `ASSIGNED` | `driver_assigned` |  |
| `EN_ROUTE` / `ON_WAY` | `en_route` |  |
| `ARRIVED` | (no current mapping) | Add `driver_arrived` status |
| `POB` / `ON_BOARD` | `on_board` |  |
| `COMPLETED` | `completed` |  |
| `CANCELLED` / `NO_SHOW` | `cancelled` |  |
| `TRANSFERRED` (demand side) | n/a from our PoV | This is what iCabbi shows the demand fleet when we (or their own partnership) take it on |
| `FAILED` | `failed` |  |

Plus `networking_status.status` on the demand side mirrors the trip's lifecycle independently of the parent booking status — we need to subscribe to that webhook.

**Also worth knowing**: the demand-side `status: TRANSFERRED` is what tells the originating dispatcher "this is no longer on your dispatch — it's in the partner network." That's the signal we send back to originators when we route their booking out.

---

## Cross-network linkage — new DB columns needed

Today our `transits` table has:
- `originatorBookingExternalId` (demand fleet's booking id)
- `recipientBookingExternalId` (supply fleet's booking id)

That's not enough for full iCabbi-partnership-protocol interop. We also need:

- `partnership_coid` — iCabbi's existing partnership chain id (here: 2661)
- `recipient_client_id` — iCabbi tenant id (here: 30092)
- `recipient_server_name` — iCabbi cluster (here: `bounds`)
- `recipient_site_id` — sub-site within the recipient tenant (here: 51)
- `track_my_taxi_link` — passenger tracking URL from supply side

This lets us reconcile a booking on both sides if iCabbi's partnership API is used as transport (Position #2 above).

---

## PII — much more than I'd assumed

The supply-side payload includes data well beyond what's needed to fulfil the trip:

- Driver: full name, home address, mobile, email, PSV number, licence number, licence expiry, photo, NI number field (empty here, but a field), bank payment date
- Vehicle: full reg, insurer, policy number, insurance expiry, plate expiry, council compliance, road tax expiry, year, colour, owner details
- Sites: full company addresses + phones

The Exchange does **not need any of this**. The recipient fleet already has it. We should:

- **Only store the booking-fulfilment subset** of driver fields: first name, last name, mobile, photo URL, vehicle make/model/colour/reg.
- **Never persist** driver address, NI number, licence number, insurance number, road tax expiry, council compliance expiry. Treat them as transient if they arrive in a webhook payload.
- **Document** what we hold, where, and for how long — this becomes part of the DPA we sign with each fleet.

This affects the PII minimisation work (P1-S3 in the readiness plan) — it's larger than I'd scoped.

---

## Financial reconciliation

Two `payment` objects, one per side. They mostly mirror, but **the differences are interesting**:

| Field | Supply side (Take Me) | Demand side (247) |
| --- | --- | --- |
| `cost` / `price` / `total` | £8.40 | £8.40 |
| `fee` | £0.20 | £0.00 |
| `processing_fee` | £0.00 | £10.00 |
| `fixed` | 1 (fixed fare) | 0 (not fixed) |
| `status` | PROCESSED | NEW |
| `distance_charged` | 3.292 | 0 |
| `processed` (timestamp) | 2026-04-13T10:55:43 | 0 (not processed) |
| `tariff_id` | 0 | 3419 |

**The £10 processing fee on the demand side is unexplained from the data alone.** Possibilities:
- It's a network commission that 247 owe Take Me
- It's a fixed admin fee 247 charges for any out-of-network booking
- It's a default value never updated

This is the kind of thing The Exchange's `feeSnapshot` should capture and lock in at routing time so both sides agree later. Today we store a `feeSnapshot` but don't reconcile post-completion against what the partners actually billed each other.

**Recommend**: at booking close, both adapters report back their payment block; we compare against the snapshot and flag drift.

---

## Two booking IDs become three

Today we track:
1. `originatorBookingExternalId` — demand side's internal id
2. `recipientBookingExternalId` — supply side's internal id

Real data shows there are actually multiple ids on each side:

**Demand side**: `id: 60039010` · `perma_id: 59757201` · `booking_id: 60198532` · `trip_id: 59757201A`

**Supply side**: `id: 19044424` · `perma_id: 18799332` · `booking_id: 19282182` · `trip_id: 18799332A`

`perma_id` is the stable cross-attempt id; `id` rolls if a booking is re-dispatched; `booking_id` is what iCabbi exposes externally; `trip_id` includes a sequence letter for multi-leg trips.

**Recommendation**: store the originator's `perma_id` (or equivalent stable id) in `originatorBookingExternalId` so we don't accidentally treat a re-dispatched job as a brand new booking. Same on the recipient side.

---

## Concrete next steps

Slotted against the GO_PLAN sprints. Three streams of work fall out of this analysis.

### Strategy (this week — blocking everything else)

1. **Sponsor decides Position #1, #2, or #3** on the iCabbi partnership protocol question. Documented in `STRATEGY.md`. **Owner: OG. Deadline: Monday's kickoff.**
2. **Talk to iCabbi commercial** about Position #2 viability. If they're hostile to a third party orchestrating across their partnership coid mechanism, that affects pricing/timeline.
3. **Reach out to 247 Birmingham and Take Me** as pilot candidates. They already have a real cross-network booking together — they're literally the proof-of-concept.

### Engineering — Sprint 2 or 3 additions

4. **Schema additions** for vias, vehicle_type, vehicle_group, attributegroup_id, account_id, payment_type, tariff_id, zone_id, priority, notes, instructions, flight_number, route, track_my_taxi_link, CO2_emissions, partnership_coid, recipient_client_id, recipient_server_name, recipient_site_id. **2 days**.
5. **Adapter rewrite** to map the real iCabbi response shape — using these two JSON files as fixtures in `__tests__/adapters/icabbi/fixtures/`. **2 days**.
6. **Explicit status mapping table** with `driver_arrived` added as a new internal status. **0.5 days**.
7. **Routing engine** must consider `attributegroup_id` and `account_id` when filtering candidates. **1 day**.
8. **Multi-stop bookings** through routing — pickup + intermediate vias + dropoff. Probably defer to Sprint 7 unless a pilot fleet needs it Day 1. **3 days**.

### Security / Compliance — slots into existing P1-S3

9. **PII minimisation** scope expands. Driver photo/name/phone keep. Address, licence, NI, insurance number — explicit drop in normalisation step. Updated retention policy. **2 days, replaces existing scope.**
10. **DPA template** mentions specifically what driver / vehicle fields we hold. Currently it would be vaguer than it needs to be.

### Operations — for go-live readiness

11. **Reconciliation job** — on booking close, compare both partners' reported payment against our `feeSnapshot`. Flag drift > 5%. **2 days**.
12. **Field-level audit on driver/vehicle webhook payloads** — assert we're dropping the fields we said we'd drop. Test fixture: these two JSONs.

---

## Open questions to ask iCabbi

If we get a meeting with their integration team this week:

1. **Partnership coid mechanism** — is it documented externally? Can a third party (us) initiate / mediate a coid partnership between two of their tenants?
2. **Driver assignment webhook timing** — supply-side `driver` block was fully populated at booking response. Does that mean iCabbi sends a `driver_assigned` webhook event the moment the driver is assigned, or do we only learn at trip completion?
3. **`partnership_booking` webhook events** — does iCabbi push updates to the demand-side tenant as the supply-side trip progresses? If yes, we'd want to subscribe.
4. **Multi-stop bookings** — what's the canonical way to create a booking with `vias[]` via their `POST /v2/bookings` endpoint?
5. **Tariff lookup** — `tariff_id: 3419` on the demand side. Is that resolvable via API? Affects fare prediction.
6. **PII fields** — can we ask iCabbi to omit driver address / licence / insurance / NI from the partnership_booking subscription payload? They're not needed for the demand side.
7. **`networking_status` webhook events** — is this a separate event stream from the parent booking status? What event_types?
8. **Idempotency** — what's the canonical idempotency key for `POST /v2/bookings`? `external_id`? `perma_id`?

---

## What this changes about The Exchange's positioning

If we land on Position #2, here's the one-line value prop for partner conversations:

> *iCabbi connects fleets one-to-one. The Exchange connects fleets many-to-many — picking the best partner for each booking based on geography, fee, and reliability, and giving you the auditable trail to invoice it later.*

This is materially different from the demo positioning today (which implicitly assumed we're the only protocol). Update marketing copy and the public landing page accordingly when conversion lands.

---

*Action: send link to this doc to sponsor for the strategy call on Monday. Schedule iCabbi commercial conversation by end of next week.*
