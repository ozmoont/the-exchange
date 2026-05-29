# The Exchange

Middleware that lets iCabbi fleets and external transport partners (CMAC, FreeNow, etc.) trade bookings through a single network. Built outside iCabbi, uses iCabbi's APIs in both directions.

## What's here

This scaffold is the MVP starting point. It includes:

- **Adapter pattern** — `iCabbiAdapter` and `CMACAdapter` behind one interface. Mock implementations included so you can run end-to-end before real API access lands.
- **Postgres schema** (Drizzle) covering partners, allow/block rules, fee configs, booking transits, events, and audit log.
- **Routing engine** with eligibility check, partner selection, fee snapshot, and idempotency.
- **Two webhook endpoints** — `/api/webhooks/ingest` (booking enters the network) and `/api/webhooks/status` (receiver updates).
- **Portal UI skeleton** — partner directory + allow/block matrix + fee config + transit log + kill switch.
- **Smoke test** that walks a booking through Fleet A → middleware → Fleet B end-to-end using mocks.

## Quick start

```bash
pnpm install
cp .env.example .env.local
# fill in DATABASE_URL (Neon, Supabase, or local Postgres)

pnpm drizzle-kit push       # apply schema
pnpm tsx src/scripts/seed.ts # seed two iCabbi fleets + one CMAC partner

pnpm dev                    # portal at http://localhost:3000
pnpm tsx src/scripts/smoke-test.ts  # run end-to-end booking flow through mocks
```

## Project layout

```
src/
  adapters/        Partner adapter interface + mock and real implementations
  db/              Drizzle schema and DB client
  lib/             Routing engine, fee resolver, idempotency, shared types
  app/             Next.js App Router — portal UI and API routes
    api/webhooks/  Webhook receivers (ingest, status, partner-specific)
  scripts/         Seed and smoke test
```

## Replacing mocks with real iCabbi

When sandbox credentials arrive, edit `src/adapters/registry.ts` and swap `MockICabbiAdapter` for `ICabbiAdapter`. The interface is unchanged — every consumer keeps working.

## What's NOT in the MVP (deliberately)

- Pre-booking aggregation (availability/quote fan-out). iCabbi already does this; we pass through.
- Odoo billing settlement. Ledger emits events; downstream system reconciles.
- Surcharge engine, cancellation fee engine. Out of MVP per the original spec.
- Automated certification test runner. Manual approval for now.

## Architecture in one sentence

iCabbi owns bookings, drivers, fares, customer comms; the Exchange owns the network — who's in it, who works with whom, and the fee snapshot that travels with each routed booking.
# the-exchange
