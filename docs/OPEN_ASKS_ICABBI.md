# Open Technical Asks — iCabbi (Frank)

*Living doc. Each item is a specific question or schema we need from
the iCabbi side to remove an assumption from our code. Severity
column says what each one blocks; items at the top block the most.
Update this file when an item resolves — don't delete it, mark it
**Confirmed** with the date and the answer, so the audit trail
stays.*

---

## How to read this

- **Severity**: `blocks-launch` (we cannot ship to a real partner
  until this is resolved), `blocks-feature` (one feature is incomplete
  without it), `nice-to-have` (we have a working assumption, this
  would let us harden it).
- **Our assumption today**: what the code does until the answer
  comes back. Often a fallback shape with a console warning.
- **What changes when resolved**: the specific code/config that
  gets updated.

---

## 1. Endpoint to push status updates back to iCabbi

**Severity**: blocks-launch
**Owner on our side**: routing engine

We send bookings TO iCabbi via `POST /Jobs`-style adapter calls,
and we receive status webhooks FROM iCabbi via
`/api/webhooks/ingest/<partnerId>?token=`. The gap is the other
direction — when a non-iCabbi partner (e.g. CMAC) accepts a booking
that originated from iCabbi, we currently have no way to tell iCabbi
"your driver isn't coming, partner XYZ has it now".

**What we need from Frank**

- The iCabbi endpoint that accepts a status update from an external
  party (Karhoo's partner-callback API? a dispatcher endpoint?
  something bespoke?).
- The exact request shape: method, path, body fields, auth (probably
  App-Key + Secret-Key but worth confirming).
- The set of statuses iCabbi accepts on this endpoint vs. silently
  ignores (e.g. they may only care about `assigned` / `completed` /
  `cancelled`, not `en_route`).
- Whether the endpoint is idempotent on retries (we'd retry with
  30s/2min/10min backoff).

**Our assumption today**

We don't push status back. The originator's iCabbi tenant sees the
booking in `received` state forever once it's been routed away.
Listed as task #208 in our backlog, deferred pending this answer.

**What changes when resolved**

- `forwardStatusUpdate` in `src/lib/routing.ts` extended to call
  the originator's adapter `forwardStatusUpdate` method.
- `ICabbiAdapter` implements that method against the agreed endpoint.
- `src/lib/outbound-webhooks.ts` already provides the retry
  transport; we just plug it in.

---

## 2. Canonical webhook envelope field names

**Severity**: blocks-feature
**Owner**: webhook ingest route

Our `/api/webhooks/ingest/<partnerId>` accepts iCabbi webhooks and
needs three things from the envelope:

- **Event id** (for idempotency / dedupe)
- **Sent-at timestamp** (for replay protection)
- **Event type** (for dispatch)

iCabbi's actual envelope shape isn't fully documented. We try
multiple plausible field names and fall back when they're missing.

**What we need from Frank**

For each piece, the **exact field name iCabbi emits** (and where
in the envelope: top-level, nested under `data`, etc.):

- Event id — we try `id`, `event_id`, `webhook_id`, `delivery_id`,
  `notification_id`. Which one does iCabbi actually use?
- Sent-at — we try `sent_at`, `timestamp`, `created_at`, `time`,
  `event_time`, `occurred_at`, plus the same set nested under
  `data`. Canonical name?
- Event type — we read `event` or `event_type`. Which is it?
- Format of the timestamp — ISO 8601 string, Unix seconds, Unix ms?

**Our assumption today**

Multi-key fallback in `src/app/api/webhooks/ingest/[partnerId]/route.ts`.
When no event id is found we synthesise one from
`sha256(partnerId || rawBody)`. When no `sent_at` is found we
skip replay protection entirely (logged as a warning). Both are
working in staging but they're fragile — a payload-shape change on
iCabbi's side could silently break dedupe.

**What changes when resolved**

Code stops trying multiple names. Idempotency becomes deterministic.
Replay protection becomes mandatory rather than best-effort.

---

## 3. iCabbi-side webhook template substitution

**Severity**: blocks-launch
**Owner**: integration

Earlier in staging testing, iCabbi was sending us literal template
strings (`#booking_id`, `#booking_status`) in webhook payloads
instead of the substituted values. This is iCabbi-side template-engine
config — likely the listener template wasn't fully wired.

**What we need from Frank**

- Confirmation that the substitution issue is resolved on the
  iCabbi side.
- A sample raw webhook payload for `booking:completed` so we can
  verify the substitution looks right.

**Our assumption today**

We detect unsubstituted templates and log loudly, but the booking
won't update because the trip id field reads as the literal string
`#booking_id`. Bookings stay in stale state.

**What changes when resolved**

Detection-of-unsubstituted-templates code can be downgraded from
"reject + log error" to "log warning" or removed entirely.

---

## 4. Booking edit endpoint (`PUT /Jobs/{id}` equivalent)

**Severity**: blocks-feature
**Owner**: edit-before-allocation flow

Our internal flow has `PATCH /api/icabbi/bookings/:id` for editing a
booking before it's been allocated to a driver. Edits to fields like
pickup time, vehicle type, passenger count are common with corporate
accounts.

We've assumed the iCabbi endpoint mirrors `POST /Jobs` with only
mutable fields included.

**What we need from Frank**

- The iCabbi endpoint shape for updating a booking.
- Which fields are mutable post-creation vs which are not.
- The edit window — after how many minutes / what status does iCabbi
  refuse the edit? (Once a driver accepts? Once en route?)
- Whether edits trigger a `booking:edit` webhook back to us (we
  subscribe to it, so probably yes).

**Our assumption today**

We accept the edit on our side and the iCabbi adapter has a
placeholder for the outbound update call. The placeholder isn't
wired to a real endpoint.

**What changes when resolved**

`ICabbiAdapter.updateBooking` (TBD method) implemented against the
real endpoint. PATCH route fully end-to-end.

---

## 5. Cancellation event semantics

**Severity**: nice-to-have
**Owner**: status mapping

We subscribe to three cancellation events:

- `booking:booking_cancelled`
- `booking:drivercancelled`
- `booking:dispatch_cancelled`

Plus `booking:noshow`.

**What we need from Frank**

- When does each fire? Specifically:
  - Passenger cancels → which event?
  - Driver cancels → which event?
  - Dispatcher cancels → which event?
  - Trip starts, driver loses signal, system gives up → which?
- Can two fire for the same booking (passenger cancels, then driver
  marks no-show)? If so, which one's the "winning" final state?
- `booking:noshow` — driver-decided (driver hits a button) or
  dispatch-decided (driver doesn't arrive, dispatch flags it)?

**Our assumption today**

All four map to canonical `cancelled` via `mapIcabbiStatus`. We
don't distinguish who cancelled. Reconciliation logic treats them
identically.

**What changes when resolved**

If the distinction matters for fee calculation or reporting (it
might — a driver no-show is different from a passenger cancel for
billing purposes), we'd split the canonical status into
`cancelled_by_passenger` / `cancelled_by_driver` / `no_show` etc.

---

## 6. Final-fare event timing

**Severity**: blocks-feature
**Owner**: reconciliation

Our `reconcileCompletedTransits` job fetches payment data for
completed trips so we can record the actual fare against the
estimated fare and compute network fees correctly.

The webhook for `booking:completed` may or may not carry the final
fare. iCabbi has a separate "FinalFareReleased" concept that
sometimes lags by minutes (waiting for tip, surge calc, etc.).

**What we need from Frank**

- Does `booking:completed` always include the final fare? Or do we
  need to poll a separate endpoint after a delay?
- If polling, what's the SLA on when the final fare is available?
- Field name(s) for the fare in the completed-event payload.
- Currency field name + format (ISO 4217 string? numeric code?).

**Our assumption today**

We pull payment data from a partner-specific endpoint when we have
one (`creds.fetchPaymentUrl`), otherwise we read fare fields from
the webhook payload itself with a multi-name fallback. Best-effort.

**What changes when resolved**

Reconciliation pipeline becomes deterministic with a real
post-completion poll schedule (or relies on the webhook entirely if
iCabbi guarantees the fare is included).

---

## 7. Outbound API rate limits

**Severity**: nice-to-have
**Owner**: adapter timeouts

We call iCabbi's API on every booking create, status forward,
webhook (re)registration, and listener teardown. At pilot scale this
is tiny; at network scale it could hit limits.

**What we need from Frank**

- Per-COID rate limit on `/Jobs` create.
- Per-COID rate limit on `/eventlisteners/{create,delete}`.
- Per-COID rate limit on whatever endpoint we end up using for
  status forwarding (Q1).
- Whether there's a global org limit that applies across COIDs.

**Our assumption today**

30-second adapter timeout, no retry-on-429 logic. We'd hit a hard
fail rather than backoff.

**What changes when resolved**

`generic_mapped` and `icabbi` adapter request helpers gain
`Retry-After`-aware backoff. We can also document the per-fleet
ceiling in `docs/INTEGRATION_GUIDE.md`.

---

## 8. Test account confirmation

**Severity**: blocks-feature (smoke testing)
**Owner**: ops

We have:

- COID 1102 — test drivers 147, 1889, 5200
- COID 2102 — test driver 999

**What we need from Frank**

- Confirmation these driver ids are still active on staging.
- Confirmation the staging API URL hasn't changed
  (`https://1stagingapi.icabbi.com/1staging`).
- Driver-app-simulator access for Miro (URL + creds) so QA can
  drive trips through the lifecycle end-to-end without needing
  Frank online.

**Our assumption today**

The accounts work as of last test ~2 days ago. No automated
heartbeat against them, so silent decay is possible.

**What changes when resolved**

Smoke test cron can target these accounts deterministically. Miro
can self-serve QA scenarios.

---

## 9. Production API base URL convention

**Severity**: blocks-launch
**Owner**: integration

Staging is on `https://1stagingapi.icabbi.com/1staging`. Production
will be on a different host (probably per-tenant or per-region).

**What we need from Frank**

- The production host naming convention so we know what to ask
  partners to paste into the Integration page's "API URL" field.
- Whether COIDs map to subdomains, paths, or query parameters.
- Whether there's a single production gateway URL that handles all
  COIDs (some dispatchers do this).

**Our assumption today**

`apiBaseUrl` is per-partner-row freeform. Operators paste whatever
iCabbi gives them. Documented in CONTRIBUTING + INTEGRATION_GUIDE.

**What changes when resolved**

Possibly auto-populate the URL based on COID (form prefill).
Definitely a clarification in the docs.

---

## Resolved (keep for history)

*Items move here once Frank confirms. Includes the date, the answer,
and the commit hash where the answer was implemented.*

- (None yet — first round of asks just compiled.)
