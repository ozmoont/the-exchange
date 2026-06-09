# The Exchange — Strategy

> **Source of truth for product scope.** Franko, Bobby, and Vicki anchor against this doc. Treat Section 1 (Locked Decisions) as **locked** — to change anything in it, surface to the founder before re-scoping.

## 1. Locked decisions

1. **The Exchange is middleware, not an internal iCabbi project.** It runs as a standalone service that uses iCabbi's APIs in both directions. iCabbi remains the system of record for bookings, drivers, fares, customer comms. The Exchange owns the *network* — who's in it, who works with whom, and the fee snapshot that travels with each routed booking. Original 28–33 week internal Partner Portal spec is the reference, not the implementation plan.

2. **Stack: Next.js 15 (App Router, TypeScript) + Drizzle ORM + Neon Postgres + Trigger.dev for queued/retried jobs.** Single repo, one deploy. Vercel preview URLs per push.

3. **Adapter pattern is non-negotiable.** Every partner integration (iCabbi tenant, CMAC, FreeNow, anything new) lives behind the `PartnerAdapter` interface in `src/lib/types.ts`. Adding a partner = writing one adapter + a partner row. No special cases in the routing engine.

4. **First-user target: iCabbi fleets + one external partner (CMAC-shaped) in the same MVP cut.** Forces the adapter abstraction from day one. Pays off the moment FreeNow / Uber / others show up.

5. **MVP scope is locked at four features.** Partner directory + bilateral allow/block matrix. Booking routing + status sync. Per-partner trip and network fees that travel with the booking payload. Admin dashboard with kill switch. Anything outside these four is either out of scope or a separate spec.

6. **Fees travel with the booking payload.** Originator → middleware → recipient carries a `feeSnapshot` (network send/receive + trip-level tech/booking/admin). Required for King County WAV and Blue Line affiliate billing. Implementation: `src/lib/fees.ts` resolves a snapshot at routing time and persists it on the transit. Non-retroactive.

7. **iCabbi is the system of record.** We do not duplicate bookings, drivers, fares, or customer comms. We forward, we route, we snapshot fees, we audit.

8. **Position vs iCabbi's existing partnership protocol — locked: Position #2.** iCabbi already has a partnership coid (cross-operator id) mechanism that moves bookings between two iCabbi tenants (confirmed in real API responses: `partnership_booking.coid`, `client_id`, `server_name`, `site_id`). The Exchange does **not** replace this protocol and does **not** ignore it. We sit on top: iCabbi acts as **transport**, The Exchange acts as the **decision layer** — picking which partner gets a job (geo + fee + reliability), exposing audit trails partners can invoice off, and bridging to non-iCabbi systems (CMAC, Karhoo/FreeNow, Cordic) under the same routing rules.

   One-liner for partner conversations: *"iCabbi connects fleets one-to-one. The Exchange connects fleets many-to-many."*

9. **Third-party initiation of coid partnerships is confirmed permitted.** The Exchange can mediate a coid partnership between two iCabbi tenants without each having pre-existing direct knowledge of the other. This is the technical bedrock of Position #2.

10. **Driver-detail visibility is per-fleet config, not network-wide.** Some accounts (corporate, VIP, regulated routes) require driver name / mobile / vehicle reg to be passed through to the demand partner. Most don't. New schema field: `partners.driverDetailsRequired: boolean`. When false, the normaliser drops the driver block from the payload sent back to the demand fleet. PII minimisation default is "off"; opt-in per partner.

11. **`networking_status` is a separate webhook event stream.** Distinct from the parent booking status events. Our inbound handler subscribes to both. The networking event tells us about the cross-tenant trip's lifecycle even when the parent booking on the demand side stays at `TRANSFERRED`.

12. **The Exchange registers as a virtual fleet inside iCabbi Networking Engine.** This is the mechanism iCabbi uses to hand us overflow bookings without modifying their engine — we appear as a participating fleet, and when no real fleet has coverage iCabbi offers the booking to us via the standard fleet offer API. Per the iCabbi BDD spec (Epic 4). Commercial confirmation received from iCabbi side. Technical work in H1.5 (between H1 and H2).

13. **Adapter pattern stays hardcoded for MVP. Configurable mapping layer is H2 work — engine now scaffolded.** The iCabbi BDD spec describes a configuration-driven mapping system where partners declare field names + transformations + value lookups without code changes. For the pilot (1–3 partners) hand-coded adapters are faster and lower-risk. **The mapping engine (`src/lib/mapping-layer.ts`), schema (`partners.fieldMappings`, `partners.authMechanism`), and tests are now in main, ahead of schedule. The first consumer — a `generic_mapped` adapter — is still deferred until partner #4 lands.** Spec: `docs/specs/H2-mapping-layer.md`.

14. **Internal canonical field names align to the iCabbi BDD spec (Section 4.1).** Our `NormalisedBooking` type and the field names we expose on outbound webhooks track iCabbi's canonical schema (`pickup.lat`, `passenger.name`, `fare.amount`, `vehicle_type`, `eta_minutes`, `booking.type = ASAP | PREBOOK`, status enum, etc.). Alignment plan in `docs/CANONICAL_FIELDS.md`. Done incrementally — new adapters use canonical names from day one; existing internal names migrate over time without breaking the wire.

## 2. Explicitly out of scope

These are NOT in the MVP. If a request fits one of these categories, Franko rejects or defers — surface to the founder if there's commercial pressure to include:

- **Configurable per-partner mapping layer** (declarative field mappings + transformations + value lookups). H2 scope per decision #13; until then adapters are hand-coded per partner.
- **Quote / availability fan-out** with parallel multi-partner queries. Spec'd in iCabbi BDD Epic 1.2 + 2.2; H2 work — for MVP we rank candidates from metadata (geo + reliability) and push directly.
- **Odoo billing settlement.** Ledger emits events; downstream system reconciles.
- **Surcharge engine** (peak hours, event-based, vehicle uplift).
- **Cancellation fee engine.**
- **Automated certification test runner** for new partners. Manual approval for now.
- **Driver-radius scoring / ML-based routing.** Rule-based only.
- **Customer-facing marketing site** for The Exchange itself. Internal admin portal only until pilot is live.
- **Self-serve partner billing portal.** Founder-only billing controls for now.

## 3. Who buys this / who uses this

| Audience | Role | Surface they see |
|---|---|---|
| **iCabbi HQ (Frank Sims)** | Super Admin — network-wide oversight, kill switch, fee config, audit | Full portal at `/` and `/audit` |
| **iCabbi Fleet Admin (Scott Ashmore / Dublin Cabs etc.)** | Fleet-scoped admin — their fleet's config, partner list, activity | `/partners/[id]` (their fleet), `/bookings` filtered |
| **iCabbi Fleet User** | Read + configure for their fleet | Same as Fleet Admin, no billing |
| **External partner (CMAC / FreeNow integration team)** | API consumer | API only — webhook ingest/status. No portal. |

## 4. Roadmap horizons

| Horizon | Window | Goal |
|---|---|---|
| **H0 — Scaffold** | Done | Project scaffolded, mock adapters, routing engine, portal pages, smoke test, team workflow installed. |
| **H1 — Real iCabbi adapter + outbound smoke** | In progress | Replace `MockICabbiAdapter` with real `ICabbiAdapter` against sandbox creds (Staging 1 COID 1102 + 2102). Validate Position #2 via real iCabbi staging round-trip. Aligned to iCabbi BDD spec for Epic 1 (inbound) and outbound creation path. |
| **H1.5 — Virtual fleet registration** | After H1 smoke is green | iCabbi registers The Exchange as a participating fleet inside their Networking Engine (per decision #12). Unlocks Epic 2 (true outbound flow) where iCabbi's standard fleet offer API hands us overflow. Loop detection, no-coverage release back to iCabbi, idempotency-key header support all in this horizon. |
| **H2 — First non-iCabbi partner + mapping layer** | Engine scaffolded ahead of schedule | CMAC-shaped or FreeNow sandbox onboarded. The **mapping layer engine + schema + tests are already in main** (`src/lib/mapping-layer.ts`, `partners.fieldMappings`, `docs/specs/H2-mapping-layer.md`) — sits idle until partner #4 is wired. Per decision #13, existing adapters remain hardcoded; new partners get a `generic_mapped` adapter (TODO when needed) that consumes the engine. Per-partner auth mechanisms (OAuth, API Key, Basic) also schema-ready via `partners.authMechanism` enum. Quote/availability fan-out shipped in tier-1 #3. |
| **H3 — Fee config UI + Auth** | After H2 | Replace seed-only fees with admin UI under `/fees`. Wrap portal with Auth.js. |
| **H4 — Production hardening** | Pre-launch | Rate limits, monitoring, signed webhooks, secret rotation, rollback runbook. |

> Franko: if a request fits an open horizon, write the spec. If it fits a future horizon, defer with a one-line note. If it fits no horizon, recommend reject.

## 5. Risks we've already named (don't re-litigate without new info)

- **Pre-booking API complexity** is the single biggest unknown. Mitigation: rely on iCabbi's existing pre-booking until H2+.
- **External partner integration timelines** (FreeNow, Uber) are slow. Mitigation: prove pattern with CMAC-shaped mock first.
- **King County WAV regulated-service fee compliance** — fees must be passenger-side only, never charged to drivers/RDAs/TNCs. Enforced at fee config level — see `src/lib/fees.ts`.
- **Webhook storms** during partner replays. Mitigation: Trigger.dev per-partner concurrency limits.

## 6. Migration story (long-term)

If iCabbi want to absorb The Exchange in-house later: same Postgres schema, same `PartnerAdapter` interface, lift `/api/webhooks/*` and worker jobs into whatever framework their platform team prefers. Portal UI is a separate concern — they keep ours or rebuild. The middleware design deliberately makes the **contract** portable, not the implementation.
