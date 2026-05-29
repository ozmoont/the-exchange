# What we need from iCabbi to start real testing

This is the concrete list of things we need from iCabbi to take The Exchange from "running against mocks on my laptop" to "live with real fleets". Copy-paste the relevant section into an email to your iCabbi contact.

The first five items are unblockers. Without them we can't run any real end-to-end test. The rest is "important but can come right after".

## 1. Sandbox credentials for at least two iCabbi tenants

We need `App-Key` and `Secret-Key` for two distinct test tenants — minimum two so we can route bookings *between* them (the bread-and-butter fleet-to-fleet flow). One alone gives us only one half of the round-trip.

Each tenant should be configured with:
- At least one test driver and vehicle in their dispatch instance
- Standard vehicle types (`standard`, `exec`) at minimum
- Both ASAP and pre-book booking types enabled

Per the v2 Swagger we read, all tenants share `https://api.icabbi.com/v2` and the App-Key/Secret-Key pair identifies the tenant. If a sandbox base URL exists at a different host (e.g. `sandbox.icabbi.com`), let us know — we have an env var for that already.

## 2. Confirmation of the booking-create response shape

`POST /v2/bookings/add` with `BookingSimpleCreate` body — the spec describes the request fully but the response is documented as the generic `Response` envelope with no schema for `body`. We need to know which field carries the new trip's identifier.

We currently try `trip_id`, `tripId`, `id`, `booking_id`, `bookingId` and a nested `booking.*` variant in that order. A real example response would pin it down in one round-trip.

**Specifically asking:** a sample successful response JSON from `POST /v2/bookings/add`.

## 3. One sample of every webhook event payload

We've built handlers for `TripStatus`, `DriverDetails`, `FinalFareReleased`, and `DriverPositionChanged` based on the Karhoo developer docs (which we understand reflect iCabbi's behaviour given the ownership). We need one real example payload of each — ideally captured from a real trip in your sandbox into [webhook.site](https://webhook.site) or similar.

Each example tells us:
- Exact field paths inside the envelope's `data` field (which is itself a JSON string)
- Status string casing (`CONFIRMED` vs `confirmed` vs `Confirmed`)
- Any iCabbi-specific extensions to the documented shape

## 4. Webhook subscription endpoint confirmation

Karhoo's docs describe webhook registration as:
```
POST /v2/webhooks/register
Headers: App-Key, Secret-Key
Body: { url, shared_secret, topics: [...] }
Response: { subscription_id }
```

Our credential entry page calls this on first connect. We need iCabbi to confirm:
- Same endpoint path under their v2 API? (We assume yes.)
- Same body shape and topic names (`TripStatus`, `DriverDetails`, `FinalFareReleased`)?
- Same HMAC-SHA512 signing of webhook payloads in `X-Karhoo-Request-Signature`? (Header name particularly — could be `X-iCabbi-Request-Signature`.)
- Delete endpoint shape (`DELETE /v2/webhooks/{subscription_id}`)?

If any of these differ, the fix is a one-line URL/header change in our adapter — not a redesign.

## 5. How a booking marked for the network reaches an external integrator

This is the architecturally important one. Karhoo's documented webhook events are all about an existing trip's lifecycle (status updates, driver assigned, final fare). There's no documented `BookingCreated` or `NetworkSend` event.

So: when an iCabbi fleet operator marks a trip for the network (or it's marked automatically by policy), how does that trip reach us as an integrator?

Possible answers we're prepared for:
- A custom webhook event we just haven't documented exposure to yet
- A polling endpoint we should hit on a schedule
- A direct API call iCabbi makes to a "network create booking" URL we configure
- We're expected to be the originating tenant's dispatch instance (different model entirely)

The answer changes whether we wire a `BookingCreated` event handler, a polling worker, or a different endpoint entirely. Our routing engine and adapter pattern handle all four — only the entry point changes.

---

## 6. Integration contact and escalation path

A real human at iCabbi we can reach when things break: the webhook stops firing, a 4xx response is mysterious, App-Key rotation accidentally locks a tenant out. Probably someone in your integrations or partner-success team. Slack channel, shared email, or a named individual all work.

## 7. Idempotency behaviour on `POST /v2/bookings/add`

If we retry a booking-create (network blip, our process restart, etc.), does iCabbi:
- Honour an `Idempotency-Key` header — we send `originatorBookingExternalId` as one
- Dedupe by an `external_reference` field on the body
- Or treat duplicate calls as creating duplicate trips (we need to dedupe ourselves)

We're conservative and send both today; knowing iCabbi's actual contract lets us simplify.

## 8. Rate limits per App-Key

If iCabbi has any documented limit (RPS, RPM, daily burst caps), we'd like to know so we can self-throttle rather than discover it under load.

## 9. Webhook retry behaviour

Karhoo docs say 3 attempts at 0s / 10s / 30s. We assume iCabbi matches. If iCabbi's retry budget differs (more attempts, longer tail), we'd just adjust the docs we hand to operators.

---

## What we'll deliver back on first real test

Once we have items 1-5, we plan to:

1. Connect two real iCabbi sandbox tenants on the partner integration page.
2. Confirm webhook auto-registration with iCabbi succeeds (or surface the 4xx and fix our endpoint path/body).
3. Create a real booking on tenant A via The Exchange's routing engine, watch it land on tenant B's iCabbi dispatch.
4. Walk that booking through its lifecycle on tenant B — `CONFIRMED → DRIVER_EN_ROUTE → POB → COMPLETED` — and confirm each webhook lands on our `/api/webhooks/ingest/<partnerId>` and applies to the right transit.
5. Verify `/webhooks` inspector shows the right outcome on each delivery, and `/bookings` reflects the lifecycle in real time.
6. Repeat with a `cancelled` flow to confirm error paths work.

End-to-end timeline once unblocked: a couple of days. Mostly waiting on the first webhook to arrive and confirming the field shapes match what we built.
