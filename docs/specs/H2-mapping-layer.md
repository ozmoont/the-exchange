# H2 — Configurable Mapping Layer (Epic 3)

*Author: Franko · Status: scaffolding (no admin UI yet, no first-consumer adapter)*

*Pairs with iCabbi BDD Epic 3 + `docs/CANONICAL_FIELDS.md` (decision #14).*

## Problem

Every non-iCabbi partner — CMAC, FreeNow, Lyft, Bolt, regional DMS — uses different field names, different value vocabularies, different transformations. The current model is hand-coded adapters per partner (decision #13 locks this for MVP and pilot). For partner #4 onwards that cost compounds: 1-2 days of bespoke engineering per partner, every time.

Epic 3 specifies a configuration-driven translation layer: partners declare their field mappings + transformations + value lookups via admin config (or seed), and the Exchange's runtime engine applies them at request/response time without code changes.

## Out of scope (this PR)

- **Admin UI for editing mappings.** Mappings are seeded via the seed script or a one-off SQL update for now. UI is a follow-up sprint.
- **First adapter that USES the mapping layer.** The engine is library-only in this iteration. The first real consumer is whichever partner #4 turns out to be.
- **Complex transformations** — string template formatting, conditional value lookups, multi-field composition. Initial taxonomy is `rename | divide | multiply | value_lookup`. Per BDD Epic 3.2 these cover the canonical FreeNow worked example.
- **Outbound webhook payload re-shaping.** Mappings drive request-out and response-in for now. Outbound status webhooks back to originators continue using canonical field names (per decision #14, internal naming).
- **Auth-mechanism configurability for inbound** (Bearer token to The Exchange). Inbound is already standardised — Bearer for iCabbi via `/api/icabbi/*`. The auth config in this spec is for **outbound** calls to external partners (OAuth 2.0, API Key Header, Basic Auth).

## Acceptance criteria

1. **Schema change** — `partners.fieldMappings JSONB` carries the per-partner mapping config; `partners.authMechanism` enum identifies the outbound auth scheme. Both nullable — partners without mappings continue to use their hand-coded adapter via `partners.adapterKey`.

2. **Runtime engine** — `src/lib/mapping-layer.ts` exposes:
   - `applyMapping(canonical, config)` — translates a `NormalisedBooking` (or any canonical object) into the partner-shaped payload
   - `reverseMapping(partnerPayload, config)` — inverse translation when the partner responds
   - Loaded-into-memory cache (per-partner mapping config cached on first read; invalidated on update). NFR target: <50ms added per request.

3. **Supported transformations** — `rename` (default), `divide`, `multiply`, `value_lookup` (e.g. saloon → ECO). Unknown transformations log a warning and fall through to rename.

4. **Required-field validation** — if a canonical field marked `required: true` has no mapping declared, `applyMapping` returns an error rather than emitting an incomplete payload. Partner row is flagged for admin review.

5. **Unit tests** — every transformation type + the BDD FreeNow worked example (vehicle_type saloon → service_class ECO; eta_seconds → eta_minutes via divide by 60).

6. **No regression to existing adapters** — `partners.fieldMappings` defaults to null. Existing adapters (`mock_icabbi`, `mock_freenow`, `icabbi`, `mock_cmac`) keep their current hand-coded translation paths. The mapping engine is opt-in per partner.

## Data model

### `partners.fieldMappings` shape

```json
{
  "fields": {
    "pickup.lat":             { "partner_field": "latitude" },
    "pickup.lng":             { "partner_field": "longitude" },
    "pickup.address":         { "partner_field": "pickup_address" },
    "dropoff.lat":            { "partner_field": "dest_latitude" },
    "dropoff.lng":            { "partner_field": "dest_longitude" },
    "dropoff.address":        { "partner_field": "dest_address" },
    "vehicle_type": {
      "partner_field":        "service_class",
      "value_lookup":         { "saloon": "ECO", "exec": "BUSINESS", "mpv": "VAN" }
    },
    "eta_minutes": {
      "partner_field":        "eta_seconds",
      "transform":            { "type": "multiply", "value": 60 }
    },
    "fare.amount":            { "partner_field": "total_price" },
    "fare.currency":          { "partner_field": "currency_code" },
    "passenger.name":         { "partner_field": "customer_name" },
    "passenger.phone":        { "partner_field": "customer_mobile" },
    "passenger.count":        { "partner_field": "pax_count" },
    "booking.id":             { "partner_field": "job_id" },
    "booking.type": {
      "partner_field":        "booking_type",
      "value_lookup":         { "ASAP": "immediate", "PREBOOK": "scheduled" }
    },
    "booking.scheduled_at":   { "partner_field": "pickup_time" },
    "booking.status": {
      "partner_field":        "job_status",
      "value_lookup_reverse": {
        "ACCEPTED":           "Accepted",
        "DRIVER_ASSIGNED":    "Driver Assigned",
        "ENROUTE":            "Driver En Route",
        "IN_PROGRESS":        "Passenger On Board",
        "COMPLETED":          "Completed",
        "CANCELLED":          "Cancelled",
        "FAILED":             "Failed"
      }
    },
    "driver.name":            { "partner_field": "driver_name" },
    "driver.phone":           { "partner_field": "driver_mobile" },
    "driver.vehicle_reg":     { "partner_field": "plate_number" }
  },
  "endpoints": {
    "create_booking":         "https://partner.example.com/bookings",
    "quote":                  "https://partner.example.com/quote",
    "cancel":                 "https://partner.example.com/cancellations"
  }
}
```

Transformation taxonomy (initial):

| `transform.type` | What it does | Reverse | Example |
|---|---|---|---|
| `(none)` | Direct rename | inverse rename | `passenger.name` ↔ `customer_name` |
| `divide` | Divide canonical value by N when emitting | multiply by N when receiving | `eta_minutes` → `eta_seconds` via `multiply: 60` (then reverse divides) |
| `multiply` | Multiply canonical value by N when emitting | divide by N when receiving | `fare.amount` (decimal £) → `total_pence` via `multiply: 100` |
| (none) + `value_lookup` | String-to-string map | reverse map | `vehicle_type` saloon → service_class ECO |
| (none) + `value_lookup_reverse` | Reverse-only map (used when canonical value is RECEIVED only, e.g. status from partner) | forward map | partner job_status COMPLETED → canonical Completed |

Composite shapes (e.g. mapping the `fare.breakdown` nested object to a partner's `price_breakdown`) are spec-only for now — Story 3.2 mentions them but the initial implementation treats them as opaque pass-through.

### `partners.authMechanism` enum

```
oauth2          — outbound calls authenticate via Bearer with token refresh
api_key_header  — single static API key sent as a configurable header
basic           — HTTP Basic auth with username/password
icabbi_app_secret — App-Key + Secret-Key pair (the existing iCabbi mechanism)
```

Auth-config payload lives in encrypted `partners.credentials` JSON alongside everything else. Shape varies by mechanism:

```json
// oauth2
{ "client_id": "...", "client_secret": "...", "token_url": "...", "scopes": [...] }

// api_key_header
{ "header_name": "X-API-Key", "key": "..." }

// basic
{ "username": "...", "password": "..." }
```

## Runtime contract

```ts
type MappingConfig = {
  fields: Record<CanonicalFieldPath, FieldMapping>;
  endpoints?: { create_booking?: string; quote?: string; cancel?: string };
};

type FieldMapping = {
  partner_field: string;
  required?: boolean;
  transform?: { type: "divide" | "multiply"; value: number };
  value_lookup?: Record<string, string>;
  value_lookup_reverse?: Record<string, string>;
};

function applyMapping(
  canonical: Record<string, unknown>,
  config: MappingConfig,
): { ok: true; payload: Record<string, unknown> } | { ok: false; missing: string[]; warnings: string[] };

function reverseMapping(
  partnerPayload: Record<string, unknown>,
  config: MappingConfig,
): { ok: true; canonical: Record<string, unknown> } | { ok: false; warnings: string[] };
```

Canonical field paths follow the dot-notation schema in `docs/CANONICAL_FIELDS.md` (e.g. `pickup.lat`, `passenger.name`). The engine walks the path to resolve the value from the canonical object.

## Performance budget

Per BDD NFR Section 7: "Field mapping translation must add no more than 50ms to any request. Mappings are loaded into memory at startup, not queried per request."

Implementation:
- In-process `Map<partnerId, MappingConfig>` cache, populated on first read
- Cache invalidation via `clearMappingCache(partnerId?)` — called when admin saves a new mapping config
- All transformations are local computation — no I/O during applyMapping/reverseMapping
- Target: <5ms per call at typical 25-field mappings. The 50ms budget is comfortable headroom

## Rollout

1. Schema (this PR)
2. Runtime engine + tests (this PR)
3. STRATEGY.md decision #13 stays as written — adapters hardcoded for MVP. Engine sits unused until partner #4
4. **Follow-up sprint:** admin UI under `/partners/[id]/mappings`. Form per canonical field with `partner_field` text + optional transform + optional value-lookup pairs. Save invalidates the in-memory cache
5. **First real consumer:** when partner #4 lands, create a new generic adapter `generic_mapped` that reads `partners.fieldMappings` and uses the engine. Set `partners.adapterKey = "generic_mapped"` on the new partner row

## Files this PR touches

- `src/db/schema.ts` — add `fieldMappings` JSONB + `authMechanism` enum on partners
- `scripts/sync-prod-schema.sql` — idempotent ALTER TABLE
- `src/lib/mapping-layer.ts` — runtime engine (new)
- `src/lib/__tests__/mapping-layer.test.ts` — unit tests (new)
- `docs/STRATEGY.md` — note Epic 3 engine scaffolded ahead of schedule

## Risks / open questions

- **Mapping config edit conflicts.** Two admins editing the same partner mapping simultaneously. Defer to last-write-wins with audit-log capture. UI can add optimistic-concurrency tokens if it becomes a problem.
- **Required-field flagging UX.** Currently we just return an error. UI work: display a "certification warning" badge on the partner list. Defer to UI sprint.
- **Pre-baked transformations are limited.** The four-type taxonomy covers FreeNow + most TNCs. CMAC's corporate booking shape may need composite/nested field mapping — flagged in spec, deferred.
- **Forwards/reverse asymmetry.** Some fields are emit-only (e.g. `passenger.name` we send, we don't read back), others are receive-only (e.g. `booking.status` we read, we don't send). The engine handles both by checking which lookup table is present.
