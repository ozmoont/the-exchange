# Integration Guide — The Exchange

*Partner-facing reference. Distribute to integration teams (iCabbi engineering, pilot fleet operators, future external partners) when starting an integration.*

*Updated 2026-06-09. Authoritative endpoint contracts; see internal specs under `docs/specs/` for design rationale.*

---

## What The Exchange does

A neutral broker between transportation networks. Two flows:

- **Inbound**: an external partner POSTs a booking to The Exchange → we route to the best available iCabbi fleet.
- **Outbound**: iCabbi has no driver coverage → offers the booking to The Exchange (registered as a virtual fleet) → we route to an external partner.

The two flows share the same routing engine, audit trail, and fee snapshot. Bilateral allow/block rules + per-pair geo + reliability scoring drive recipient selection.

---

## Base URL

```
Production:  https://the-exchange-z2wp.vercel.app
Staging:     https://the-exchange-z2wp.vercel.app   (same URL today; staging env-flagged via DATABASE_URL)
```

All API endpoints under `/api/`. JSON in both directions. ISO 8601 timestamps. Currency in major units (decimal £) on the wire — internally normalised to pence.

---

## Authentication

Two distinct auth mechanisms, depending on whether the caller is iCabbi acting as a fleet or an external aggregator.

### Inbound from iCabbi (virtual-fleet calls)

**Bearer token.** Each iCabbi tenant we connect to gets its own token, issued via our admin UI at `/partners/[id]/integration` and revealed once. Include in every request:

```
Authorization: Bearer <64-char base64url token>
```

The token identifies the originator partner. Rate limit: 60 requests/min per token (tunable). Tokens are 48 bytes of entropy, base64url-encoded.

### Inbound webhook events from any partner

**HMAC-SHA512.** The webhook signing secret is generated on first Connect and revealed once. Sign the raw body bytes (UTF-8) and place the lowercase hex digest in:

```
X-Karhoo-Request-Signature: <hex digest>
```

Replay protection: requests with `sent_at` older than 5 minutes are rejected (`401 stale_event`). Set `WEBHOOK_MAX_AGE_MS` env var on our side to tune.

> **iCabbi-side staging note (temporary):** if a partner can't sign (their UI takes only a URL), set `ICABBI_SKIP_WEBHOOK_HMAC=true` on our deployment. Replay-protection + idempotency still enforced. Production must turn this off once the partner's signing convention is confirmed.

---

## Endpoints — Inbound from iCabbi (Outbound flow)

iCabbi calls these when offering a booking to us as a virtual fleet.

### `POST /api/icabbi/bookings` — offer a booking

```bash
curl -i -X POST 'https://the-exchange-z2wp.vercel.app/api/icabbi/bookings' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "booking_id":     "icabbi-001",
    "booking_type":   "ASAP",
    "scheduled_at":   "2026-06-09T14:00:00Z",   // PREBOOK only
    "pickup":         { "lat": 51.507, "lng": -0.128, "address": "Trafalgar Square, London" },
    "dropoff":        { "lat": 51.470, "lng": -0.454, "address": "Heathrow Terminal 5" },
    "passenger":      { "name": "Jane Doe", "phone": "+447700900000", "count": 1 },
    "vehicle_type":   "saloon",                  // saloon | exec | mpv | wav | van
    "fare_estimate":  42.50,
    "currency":       "GBP",
    "instructions":   "Ring buzzer 3",
    "notes":          "VIP account"
  }'
```

**Field tolerance:** the normaliser accepts `lat`/`lng` or `latitude`/`longitude`; `address` or `formatted`; `passenger.name` or `customer_name`; `passenger.phone` or `customer_phone`/`customer_mobile`; `booking_type` or `bookingType`. Required fields: `booking_id`, both lat/lng coordinates, both addresses, passenger name/phone. `scheduled_at` required for PREBOOK.

**Responses:**

| Code | Body | Meaning |
|---|---|---|
| 200 | `{"status":"accepted","exchange_transit_id":"<uuid>"}` | Booking received, routing kicked off async |
| 400 | `{"error":"missing_or_invalid_fields","missingFields":[...]}` | Required field missing/invalid |
| 401 | `{"error":"missing_authorization" \| "unknown_token" \| "invalid_token_format"}` | Auth failed |
| 409 | `{"status":"duplicate","exchange_transit_id":"<uuid>","current_status":"..."}` | Same `booking_id` from same originator → idempotent return |
| 422 | `{"error":"no_coverage"}` | Routing found no eligible partner |
| 429 | `{"error":"rate_limited","retry_after_seconds":N}` | Per-partner rate limit hit |

**Response latency target:** < 2 seconds (per BDD NFR). Returns 200 once received; routing decision lands within ~60 seconds.

### `POST /api/icabbi/cancellations` — cancel a previously-offered booking

```bash
curl -i -X POST 'https://the-exchange-z2wp.vercel.app/api/icabbi/cancellations' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "booking_id":    "icabbi-001",
    "reason":        "passenger_cancelled",
    "reason_detail": "Booking made in error"
  }'
```

Cascades to the recipient adapter's cancelBooking (best-effort). Idempotent — cancelling an already-terminal booking returns 200 with `current_status`.

| Code | Meaning |
|---|---|
| 200 `{"status":"cancelled","transit_id":"<uuid>"}` | Cancelled |
| 200 `{"status":"already_terminal","current_status":"completed"}` | Booking already completed/cancelled — idempotent no-op |
| 404 | `booking_id` not found for this originator |

### `PATCH /api/icabbi/bookings/[booking_id]` — edit before allocation

Edit pickup/dropoff/scheduled_at/vehicle_type/passenger/notes on a booking that's still in `received`/`routing`/`no_match`/`paused`. Once pushed to a recipient, returns 409 — cancel + re-offer is required.

```bash
curl -i -X PATCH 'https://the-exchange-z2wp.vercel.app/api/icabbi/bookings/icabbi-001' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{ "dropoff": { "lat": 51.510, "lng": -0.140, "address": "Aldwych" } }'
```

Partial PATCH — unspecified fields stay as they were. URL `booking_id` is authoritative (body `booking_id` is ignored if present).

| Code | Meaning |
|---|---|
| 200 `{"status":"updated","updated_fields":["dropoff"]}` | Applied |
| 200 `{"status":"no_changes"}` | PATCH matched current values |
| 404 | Booking not found |
| 409 `{"error":"already_allocated","current_status":"pushed"}` | Too late — cancel + re-offer |

### `POST /api/quote` — availability + ETA fan-out

Ask "can you fulfil this booking? what's the best ETA?" without creating one. Runs a parallel fan-out to every eligible non-iCabbi partner with a 1500ms total budget.

```bash
curl -s -X POST 'https://the-exchange-z2wp.vercel.app/api/quote' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "booking_id":    "quote-test-001",
    "booking_type":  "ASAP",
    "pickup":        { "lat": 51.507, "lng": -0.128, "address": "Trafalgar Square" },
    "dropoff":       { "lat": 51.470, "lng": -0.454, "address": "Heathrow T5" },
    "passenger":     { "name": "T", "phone": "+44 7000 0" },
    "vehicle_type":  "saloon"
  }'
```

Response:

```json
{
  "available": true,
  "candidates": 1,
  "available_partners": 1,
  "best_eta_minutes": 5,
  "partners": [
    {
      "recipient_id":         "4550a294-...",
      "available":            true,
      "eta_minutes":          5,
      "fare_estimate_pence":  null,
      "currency":             "GBP",
      "reason":               null,
      "elapsed_ms":           248,
      "from_adapter":         true
    }
  ]
}
```

---

## Endpoints — Inbound webhooks (status from any partner to us)

### `POST /api/webhooks/ingest/[partnerId]` — status events from a connected partner

```bash
curl -i -X POST 'https://the-exchange-z2wp.vercel.app/api/webhooks/ingest/<partner-uuid>' \
  -H 'X-Karhoo-Request-Signature: <hex digest>' \
  -H 'Content-Type: application/json' \
  -d '{
    "userId":     "+447700900000",
    "event":      "TripStatus",
    "properties": {
      "booking_id":          "12345",
      "status":              "DRIVER_ASSIGNED",
      "driver_name":         "Jane Smith",
      "vehicle_reg":         "AB12 CDE",
      "pickup_address":      "Trafalgar Square, London",
      "destination_address": "Heathrow Terminal 5",
      "eta":                 5
    },
    "timestamp": "2026-06-09T13:00:00Z"
  }'
```

The handler is tolerant: it accepts the canonical Karhoo envelope (`{id, event_type, sent_at, data}`), the iCabbi properties shape above, and direct iCabbi v2 booking objects. Envelope id is optional — if absent, we hash the body for idempotency.

| Status field accepted | Maps to |
|---|---|
| `ACCEPTED` / `Accepted` | accepted |
| `DRIVER_ASSIGNED` / `Driver Assigned` | driver_assigned |
| `ARRIVED` | driver_arrived |
| `ENROUTE` / `EN_ROUTE` / `Driver En Route` | en_route |
| `POB` / `Passenger On Board` / `IN_PROGRESS` | on_board |
| `COMPLETED` / `Completed` | completed |
| `CANCELLED` / `Cancelled` | cancelled |
| `FAILED` / `Failed` | failed |

### Outbound webhook delivery (us → partner)

When a transit advances and the originator has `webhookUrl` configured, we POST:

```http
POST <partner-webhook-url>
Content-Type: application/json
X-Karhoo-Request-Signature: <HMAC-SHA512(body, partner_secret)>
X-Exchange-Event-Id: <stable id derived from transit + event type>
X-Exchange-Event-Type: TripStatus

{
  "id":             "<sha256 prefix>",
  "event_type":     "TripStatus",
  "sent_at":        "2026-06-09T13:00:00Z",
  "attempt_number": 1,
  "checksum":       "<hex>",
  "data":           "{\"booking_id\":\"...\",\"status\":\"DRIVER_ASSIGNED\",...}"
}
```

**Retry policy (BDD Story 1.3):** delivery fail → retry at +30s / +2min / +10min. After the third retry, the delivery is flagged for admin review (visible on `/webhooks` inspector) and we stop retrying. Partner should return `200 OK` on success — we treat any 2xx as delivered.

---

## Idempotency

- **Booking creation (`POST /api/icabbi/bookings`):** unique on `(originator_partner_id, booking_id)`. Duplicate submissions return `409 duplicate` with the original transit id.
- **Webhook events (`POST /api/webhooks/ingest/...`):** unique on `(source, source_event_id)`. Duplicates return `200 duplicate` with no side effects.
- **Outbound webhook delivery:** event id is deterministic — partners can dedupe on `X-Exchange-Event-Id`.

---

## Status mapping (our internal enum)

```
received          — transit row created, awaiting routing
routing           — routing engine is selecting a candidate
no_match          — exhausted candidates, no eligible recipient
pushed            — sent to recipient, awaiting their accept
accepted          — recipient confirmed
driver_assigned   — driver allocated
driver_arrived    — driver at pickup (iCabbi-specific; collapses to en_route on canonical wire)
en_route          — driver travelling to pickup (or with passenger)
on_board          — passenger picked up
completed         — trip finished
cancelled         — passenger or partner cancelled
failed            — trip could not complete
paused            — held by network kill switch
error_auth        — partner authentication failure
error_other       — anything else
```

---

## Error code semantics

| HTTP | Treatment |
|---|---|
| 200 | Success — do not retry |
| 4xx | Bad input — fix and resubmit, do not retry |
| 409 | Duplicate or conflict — read the body, no action usually needed |
| 422 | Semantic failure (e.g. no coverage) — partner-specific recovery |
| 429 | Rate-limited — honour `Retry-After` header |
| 5xx | Our side broke — partner may retry with exponential backoff |

---

## Quick smoke from a terminal

```bash
TOKEN='<bearer token from our integration page>'

# 1. Quote
curl -s -X POST 'https://the-exchange-z2wp.vercel.app/api/quote' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"booking_id":"sm-001","booking_type":"ASAP","pickup":{"lat":51.507,"lng":-0.128,"address":"X"},"dropoff":{"lat":51.470,"lng":-0.454,"address":"Y"},"passenger":{"name":"T","phone":"+44"},"vehicle_type":"saloon"}'

# 2. Create
curl -s -X POST 'https://the-exchange-z2wp.vercel.app/api/icabbi/bookings' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"booking_id":"sm-001","booking_type":"ASAP","pickup":{"lat":51.507,"lng":-0.128,"address":"X"},"dropoff":{"lat":51.470,"lng":-0.454,"address":"Y"},"passenger":{"name":"T","phone":"+44"},"vehicle_type":"saloon"}'

# 3. Edit (before allocation)
curl -s -X PATCH 'https://the-exchange-z2wp.vercel.app/api/icabbi/bookings/sm-001' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dropoff":{"lat":51.510,"lng":-0.140,"address":"Aldwych"}}'

# 4. Cancel
curl -s -X POST 'https://the-exchange-z2wp.vercel.app/api/icabbi/cancellations' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"booking_id":"sm-001","reason":"passenger_cancelled"}'
```

---

## Observability / debugging

- `/status` — public health page (no auth). System components, synthetic monitor, activity counts.
- `/webhooks` — every webhook delivery in + out, outcome, retry state, full payload preview. Filterable by source / outcome.
- `/transits/<id>` — booking lifecycle, routing trace (every candidate considered + score), fee snapshot, audit timeline.
- `/audit` — every consequential admin action with actor and before/after JSON.

For any request issue, the response `X-Vercel-Id` header is the request id. Search Vercel logs by that id to find the function invocation.

---

## Canonical field schema

See `docs/CANONICAL_FIELDS.md` in our repo for the full canonical field catalogue + status enum mapping. The mapping layer (Epic 3) lets non-iCabbi partners declare their own field names + value vocabularies and have them translated automatically — see `docs/specs/H2-mapping-layer.md`.

---

## Contact

For integration issues: <ops@howl.ie> *(pilot phase — moves to a partner-specific channel post-launch)*.
For commercial: OG.
Engineering: this repo's PRs.
