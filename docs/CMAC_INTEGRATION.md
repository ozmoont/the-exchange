# CMAC Integration

CMAC is our first external partner wired up via the H2 mapping engine
(Epic 3) instead of a hand-coded adapter. The intent: prove that a new
partner can be onboarded with a config row, encrypted credentials, and
zero new TypeScript.

End-to-end verified against `testapi.cmacgroup.com` via
`pnpm smoke:cmac -- --create`. Quote, create, and cancel all return
2xx on the wire. Everything in this doc is **confirmed** against live
responses unless otherwise noted.

---

## What CMAC is

- **Partner kind**: `external_aggregator` (same family as FreeNow — we
  push work to them, they push work to us).
- **Adapter**: `generic_mapped`. No CMAC-specific TypeScript.
- **Auth**: HTTP Basic. Username + password are UUIDs issued via
  CMAC's developer portal. Test credentials live in
  `partners.credentials` (encrypted) on the seeded partner row — they
  are not committed to the repo.

---

## API surface

Base URL: `https://testapi.cmacgroup.com`
(Production base will differ — update the mapping config's `endpoints`
when CMAC issues live credentials.)

| Operation       | Method | Path                  | Notes                                                |
|-----------------|--------|-----------------------|------------------------------------------------------|
| Quote           | POST   | `/JobsQuote`          | Pre-booking availability + fare. Returns 200.        |
| Create booking  | POST   | `/Jobs`               | Returns 200 + numeric `id`.                          |
| Get booking     | GET    | `/Jobs/{id}`          | Status + assignment poll.                            |
| Update booking  | PUT    | `/Jobs/{id}`          | Edit-before-allocation. Body shape **(unverified)**. |
| Cancel booking  | DELETE | `/Jobs/{id}`          | Returns 202 with no body.                            |

`{id}` is substituted at call time from the booking's `external_id`
(the numeric job id CMAC returned on create). The adapter handles
substitution generically via `resolveEndpoint(spec, externalId)` in
`src/lib/mapping-layer.ts`.

Optional header `x-api-version: "1"` is accepted by the API. We don't
send it today — add to the adapter's static headers if CMAC starts
versioning endpoints.

### Auth header

```
Authorization: Basic base64(username:password)
```

Built by `GenericMappedAdapter.authHeaders()` when
`authMechanism: "basic"` is set on the partner row.

### Cancel — 202 handling

CMAC returns HTTP 202 Accepted with no body when a cancel is
successful. `generic_mapped`'s `request()` helper treats any 2xx as
ok and ignores the empty body, so this works without special casing.

---

## Vehicle type enum

CMAC uses numeric vehicle type IDs. Full enum, confirmed against
Swagger:

| Canonical          | CMAC value | CMAC label       |
|--------------------|------------|------------------|
| (no canonical)     | `0`        | Any              |
| `saloon`           | `1`        | StandardCar      |
| (none)             | `3`        | MidiCoach        |
| (none)             | `4`        | Coach            |
| `mpv`              | `5`        | Mpv              |
| `exec`             | `6`        | ExecutiveCar     |
| `people_carrier`   | `7`        | PeopleCarrier    |
| (none)             | `12`       | DdaCoach         |
| `wav`              | `14`       | DdaCar           |
| `black_cab`        | `99`       | BlackCab         |

Wired via `fields.vehicle_type.value_lookup` in the mapping config.
The engine emits the numeric value out (canonical → partner) and
reverse-maps it back on inbound (partner → canonical). CMAC defaults
to `StandardCar` (1) when omitted.

Note: CMAC's "DdaCar" (Disability Discrimination Act car) is the same
semantic as our canonical `wav` (wheelchair accessible vehicle).

---

## Job status enum

CMAC pushes job status updates via numeric IDs (confirmed in their
documentation):

| CMAC ID | CMAC label   | Canonical status   |
|---------|--------------|--------------------|
| `1`     | Created      | `received`         |
| `2`     | Confirmed    | `accepted`         |
| `9`     | Assigned     | `driver_assigned`  |
| `3`     | Dispatched   | `en_route`         |
| `8`     | Arrived      | `driver_arrived`   |
| `4`     | On Board     | `on_board`         |
| `5`     | Completed    | `completed`        |
| `10`    | No Job       | `no_match`         |

Wired via `fields.booking.status.value_lookup_reverse` — receive-only,
since we don't push our status TO CMAC, we only read it from them.

Live response shows `status: 1` (Created) on the create response — the
status field name is `status` (not `jobStatusId` as we initially
assumed; the field is unwrapped at the top level).

---

## Field mapping (canonical → CMAC)

All field names below are **confirmed** against live API responses.

### Locations — `from` / `to` (ShortAddress)

CMAC nests pickup and dropoff inside `from` and `to` objects with this
shape:

```json
{ "lat": 51.47, "long": -0.4543, "address1": "Heathrow T5",
  "town": null, "postcode": null, "country": "UK" }
```

| Canonical          | CMAC field           | Notes                          |
|--------------------|----------------------|--------------------------------|
| `pickup.lat`       | `from.lat`           | Float. Required (or postcode). |
| `pickup.lng`       | `from.long`          | Float. **Field name is `long`, not `longitude`.** |
| `pickup.address`   | `from.address1`      | Required.                      |
| `dropoff.lat`      | `to.lat`             | Float.                         |
| `dropoff.lng`      | `to.long`            | Float.                         |
| `dropoff.address`  | `to.address1`        | Required.                      |

CMAC accepts either `postcode` OR both `lat`+`long`. We always send
lat+long.

### Passenger

CMAC uses "lead passenger" terminology and a strict phone format.

| Canonical          | CMAC field            | Notes                                        |
|--------------------|-----------------------|----------------------------------------------|
| `passenger.name`   | `leadPassengerName`   | Required, max 100 chars.                     |
| `passenger.phone`  | `leadPassengerPhone`  | Required. 11-15 chars. **No `+`, no spaces, no leading 0.** Country code prefix only, e.g. `447700900123`. |
| `passenger.count`  | `numberOfPassengers`  | Integer 1-1000. Required for quote pricing.  |

### Booking metadata

| Canonical              | CMAC field              | Notes                                        |
|------------------------|-------------------------|----------------------------------------------|
| `booking.id`           | `customerReference`     | Our id, string max 50. Echoed back in response. |
| `booking.scheduled_at` | `departs`               | **REQUIRED** (defaults to `MinValue` if missing → "too far in past" 400). Local time `yyyy-MM-dd HH:mm`, **no timezone marker**. The `format_datetime` transform handles UTC → Europe/London conversion. |
| `vehicle_type`         | `vehicleType`           | Integer enum (see table above).              |
| `notes`                | `notes`                 | Optional, max 1000 chars.                    |

### Fields NOT in the request schema

These canonical fields are deliberately NOT mapped to the CMAC request:

- `fare.amount` / `fare.currency` — CMAC's request doesn't accept these.
  Their `price` field is read-only-from-quote (you can pass it back to
  lock a quoted price, but we don't use that flow).
- `booking.type` — there's no `bookingType` field on CMAC's schema.
  The closest is `jobType` (1=ActiveJob, 3=DormantJob), defaulted to
  ActiveJob; we leave it at the default.

---

## Response shapes (confirmed against live test API)

### POST /Jobs response — booking record

```json
{
  "id": 9821600,                    // CMAC's job id (numeric)
  "journeyId": 11281404,
  "bookingId": null,                // assigned when supplier accepts
  "createdDate": "2026-06-10T10:47:49",
  "price": 0.00,                    // 0 until quote-locked or completed
  "journeyPrice": 0.00,
  "currency": "GBP",
  "conversionRate": 1,
  "supplierAttributes": { "currency": "GBP", "conversionRate": 1 },
  "finalPrice": false,
  "tax": 0,
  "journeyTax": 0,
  "departs": "2026-06-10T11:47:00",
  "from":  { "address1": "...", "town": null, "postCode": "",
             "lat": 51.47, "long": -0.4543, "country": "UK" },
  "to":    { ... },
  "vias": [],
  "distance": 16.89,
  "duration": 2059,
  "numberOfPassengers": 2,
  "leadPassengerName": "...",
  "leadPassengerPhone": "...",
  "leadPassengerEmailAddress": null,
  "notes": "...",
  "bookerEmail": null,
  "customerReference": "...",
  "flightNumber": null,
  "vehicleType": 1,
  "status": 1,                      // see job status enum table
  "costCentre": "",
  "driverName": null,
  "driverRegistration": null,
  "driverVehicle": null,
  "driverPhoneNumber": null
}
```

The adapter pulls `id` (the top-level numeric job id) as our
`externalId`. Driver fields are null until CMAC assigns a supplier and
they accept — that's communicated via status webhooks (TBD; CMAC
webhooks endpoint integration is a future task).

### POST /JobsQuote response — multi-supplier quote

```json
{
  "success": true,
  "price": 55.30,                   // aggregate fare (£)
  "journeyPrice": 53.80,            // journey-only, ex extras
  "vehicleType": 1,
  "estimatedCO2": 5.7519,           // kg CO2
  "error": null,
  "jobQuotes": [
    { "id": 949, "supplierName": "Addison Lee (London)",
      "price": 55.30, "journeyPrice": 53.80,
      "etaInSeconds": null,
      "extras": [{ "description": "Clean Air Fees", "amount": 1.50 }] },
    { "id": 5014, "supplierName": "The Chauffeur Group (London)", ... },
    ...
  ],
  "distance": 16.89,
  "duration": 2059,
  "from": { ... },
  "to":   { ... }
}
```

Today we only surface `available: true` from the quote — we don't
parse `price` or `etaInSeconds` back into canonical fan-out scoring.
That's task #233.

### DELETE /Jobs/{id} response

HTTP 202 Accepted, empty body. Confirmed.

---

## Onboarding sequence

1. Run `pnpm seed:cmac-test` to insert the CMAC partner row with the
   `generic_mapped` adapter, basic auth, and the full mapping config.
2. Verify on `/partners/<cmac-id>/mappings` — JSON should match this
   doc's field mapping section.
3. Run `pnpm smoke:cmac -- --create` from your laptop to verify quote
   + create + cancel against CMAC's test API.
4. Once live: the partner is bilaterally allowed with COID 1102, COID
   2102, and FreeNow Dummy — routing will fan out to CMAC when those
   tenants are offline.

---

## Test credentials

The CMAC test account is a long-lived UUID pair issued by CMAC's
developer portal. They are pasted into the partner row's
`credentials` JSONB column (encrypted at rest via AES-256-GCM, keyed
by `PARTNER_CREDENTIAL_KEY`) by the seed script.

To rotate: re-run `pnpm seed:cmac-test` with the new credentials in
the script (the existing partner row's credentials column is
overwritten in-place by the seeder).

**Never echo these credentials back to chat, logs, or audit events.**
The encryption-at-rest gives us cold-storage protection; PII
minimisation governs in-flight logging.

---

## Known gaps / follow-ups

- **Quote response parsing** (#233) — extract `price`, `distance`,
  `duration`, `jobQuotes[0].etaInSeconds` so fan-out routing can use
  CMAC's real fare/ETA estimates instead of just `available: true`.
- **Update endpoint** — `PUT /Jobs/{id}` body shape is unverified.
  Working assumption: same shape as create with mutable fields only.
- **Inbound webhooks** — CMAC's webhook subscription mechanism isn't
  wired yet. Today we'd poll `GET /Jobs/{id}` for status updates;
  webhook integration is a separate task.
- **GENERIC_MAPPED_QUIET=1** — set this in prod once the partner shape
  is locked to suppress 2xx response body logging (cuts log volume).
