# Test Strategy

Owned by **Miro**. This document tells every contributor (human or agent) what to test, at which layer, and where the test file lives. If you add a new surface and don't update this doc, your PR isn't done.

## Test layers

### Unit — `src/lib/__tests__/`

Pure functions. No I/O. No framework. Fast (< 50ms each).

Target the revenue-critical paths first:
- Fee resolution (`src/lib/fees.ts`) — money math is non-negotiable to get right.
- Routing eligibility (`src/lib/routing.ts`) — mutual allow, vehicle/booking type match, kill-switch behaviour.
- Idempotency (`src/lib/idempotency.ts`) — duplicates must be no-ops.
- Adapter contract conformance — every adapter must satisfy the `PartnerAdapter` interface.

### Component — `src/components/**/__tests__/`

React components rendered with `@testing-library/react`. Test behaviour the user sees, not implementation details.
- No snapshot tests of large trees
- Mock context providers at the boundary

### API route — `src/app/api/__tests__/`

Route handlers tested with mocked dependencies at the module edge:
- Drizzle client mocked
- Partner adapters mocked at the registry level
- Webhook idempotency tested with realistic duplicate deliveries

### E2E — Playwright (when added)

Full-flow user journeys. Reserved for revenue-critical paths and pre-launch smoke checks. Each scenario is documented here before the test exists.

In the meantime the `src/scripts/smoke-test.ts` script is the de-facto e2e — it walks a booking from originator through routing to recipient and asserts on the persisted transit. Extend it rather than parallel-tracking.

## Standards

- **Every test can fail.** Green-by-default assertions don't count.
- **Test behaviour, not implementation.** `"declines a booking when no mutually-allowed partner exists"`, not `"returns no_match from routeBooking"`.
- **Mock at the boundary.** Mock the adapter at the registry level; mock the Drizzle client at the module edge. Never hit a real iCabbi tenant or a real Postgres in unit tests.
- **No third-party SDK tests.** Trust the boundary; mock at it.

## Coverage philosophy

Coverage is a result, not a goal. Aim for revenue-critical paths and known-fragile areas first. Don't chase 100%.

For The Exchange specifically, revenue-critical = anything that decides:
- Who receives a booking (`src/lib/routing.ts`)
- What fee snapshot travels with it (`src/lib/fees.ts`)
- Whether a duplicate delivery is acted on or skipped (`src/lib/idempotency.ts`)
- Whether the kill switch holds traffic (`src/lib/routing.ts` + `src/db/schema.ts` networkControls)

## Running tests

```bash
pnpm test       # watch mode
pnpm test:run   # one-shot (used by Miro and CI)
pnpm smoke      # end-to-end smoke against mocks
```

## Current surfaces

<!-- Miro updates this section every time a new feature lands. -->

| Surface | Layer | Test file | Notes |
|---|---|---|---|
| Fee snapshot resolution | unit | `src/lib/__tests__/fees.test.ts` | Default fallback, pair override, channel/booking-type skip, percentage fee math |
| Routing eligibility | unit | `src/lib/__tests__/routing.test.ts` | Mutual allow required, kill switch, vehicle/booking type match |
| End-to-end booking flow | smoke | `src/scripts/smoke-test.ts` | Dublin → Cork happy path, Dublin → CMAC prebook with trip fees, idempotent redelivery |
