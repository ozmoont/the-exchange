# The Exchange — Project Status

*Last updated: June 2026. This is the "where are we" doc for new
contributors and partners. Less marketing than `README` would be,
more honest than a board update.*

---

## What it is

The Exchange is middleware that sits beside iCabbi's dispatch system
and routes bookings across a network of partner fleets. When a
fleet's own drivers can't service a booking, we find another fleet
that can — instantly, with rules, fees, and reliability scoring all
travelling with the trip.

Think of it as the missing layer between "I have a booking I can't
fulfil" and "I have a partner network I could route it to".

## Why it exists

Without The Exchange, a fleet's only option when their own drivers
are unavailable is to lose the booking. Manual workarounds (calling
another fleet, splitting a corporate account across operators) are
slow, error-prone, and don't scale. The Exchange automates the
match-and-route, takes a per-trip + per-fleet fee, and gives
operators a control plane over who's in their network and on what
terms.

The platform is partner-agnostic by design. iCabbi was the first
integration (most of our partner base today) but the architecture
treats it as just one more dispatcher kind — see "Partner kinds" below.

---

## What's built

### Routing engine

- **Eligibility filter** — active partners with mutual-allow rules,
  matching vehicle type + booking type, within service radius of the
  pickup point.
- **Scoring** — distance, reliability metrics (acceptance rate,
  completion rate, auto-reroute rate, median acceptance time, all
  computed over a rolling 7-day window), and live fan-out quote data
  combine into a single rank.
- **Fan-out** — `POST /api/quote` queries every eligible partner in
  parallel and returns availability + fare estimates within a 1.5s
  NFR (Promise.race-capped at the orchestrator).
- **Waterfall** — if the top candidate doesn't accept within the
  configurable offer window (default 90s ASAP / 5min prebook),
  reroute to the next candidate, repeat.
- **Loop prevention** — iCabbi-kind originators are excluded from
  iCabbi-kind candidate pools.
- **Async processing** — bookings hit a Postgres-polling queue;
  routing runs on a cron drain so webhook ingest stays ack-fast.

### Partner kinds

- **iCabbi fleets** — full integration. Real adapter, webhook
  auto-subscription via `/eventlisteners/{create,delete}`, 13 event
  types tracked. Currently piloting against staging tenants COID
  1102 + 2102.
- **External aggregators** — partners like CMAC and FreeNow who push
  and pull work. Wired via the **H2 mapping engine** (config-driven,
  no per-partner TypeScript).
- **Virtual fleets** — H1.5 pattern where iCabbi calls our API to
  offload a booking they can't serve, and we route it onto the wider
  network.

### Integrations live

- **iCabbi** — real adapter, staging COID 1102 + 2102 tested, mock
  available for demos.
- **CMAC** — first H2 mapping-engine partner. End-to-end verified:
  quote, create, cancel against `testapi.cmacgroup.com`. Vehicle
  enum, status enum, datetime transform all confirmed on the wire.
- **FreeNow Dummy** — mock originator for staging round-trips.
  No real FreeNow API key required.

### Authentication & security

- Magic-link sign-in via Resend (domain-verified sender).
- HMAC-SHA512 cookie middleware for sessions.
- RBAC: super_admin, fleet_admin, fleet_user.
- Partner credentials encrypted at rest with AES-256-GCM
  (`PARTNER_CREDENTIAL_KEY`).
- Inbound webhooks accept **either** `?token=<secret>` query auth
  (iCabbi-style) **or** HMAC-SHA512 signature header (Karhoo-style).
- Per-partner Bearer tokens for our inbound API.
- Postgres-backed rate limiting on every public endpoint.
- Webhook replay protection via `sent_at` freshness window.

### H2 mapping engine

The bet that Epic 3 was right: new partners onboard via a JSONB
config, not new code. CMAC was the proof — zero CMAC-specific
TypeScript anywhere in the repo. Engine supports:

- Field renames + dotted path nesting (`from.lat`)
- Value lookups (canonical enum → partner enum, with numeric tolerance)
- Receive-only reverse lookups (status code translation)
- Divide/multiply transforms (unit conversions)
- `format_datetime` transform (ISO UTC → partner local time)
- Per-endpoint URL + method + `{external_id}` templating
- Convention-based response fallback (price/eta/currency extraction)

### Operations surface

- Admin dashboard with kill switch
- `/audit` log (every credential change + status change tracked)
- `/webhooks` delivery inspector
- `/distribution` (who got what, at a glance)
- `/fees` per-partner + per-pair config
- Per-partner health metrics on the partner detail page
- Live "in-flight to me" feed (fleet perspective)
- Pause-receiving toggle (fleet self-serve)
- Earnings card (7d + 30d)
- Auto-suspend with cooldown when reliability drops
- Synthetic test runs (cron-powered health checks)
- Public `/status` page

### Quality & tooling

- Vitest test suite
- GitHub Actions CI: typecheck + vitest + docs-first (catches
  deprecated Next.js patterns)
- Drizzle migrations with idempotent runner
- 7 persona subagent files (Bobby, Derek, Eamon, Franko, **Miro**,
  Mykola, Vicki)
- AGENTS.md meta-doc + PR template with role-based checklists
- Property tests for fee snapshot determinism

### Observability

- Sentry wired via Next.js instrumentation hook (DSN-driven)
- Structured logger with context fields
- Captured errors surface as Sentry tags
- Runbook for the most common production issues

---

## What's in flight

| Item                                            | Status                     | Notes                                                  |
|-------------------------------------------------|----------------------------|--------------------------------------------------------|
| Status forwarding back to originator            | Blocked on Frank's endpoint| Issue filed. iCabbi side needs to confirm path + body. |
| iCabbi staging end-to-end smoke                 | Pending                    | New webhook flow needs live verification.              |
| `MappingConfig.response_fields` for asymmetric quote responses | Designed, not built | Convention fallback covers CMAC today.                 |
| `format_datetime` unit tests                    | TODO                       | Currently only the live smoke covers it.               |
| `PROJECT_OVERVIEW.md` refresh                   | TODO                       | Last touched before today's CMAC + iCabbi work.        |
| Custom production domain                        | Not attached               | Prod is still on `*.vercel.app`.                       |

These are tracked as GitHub Issues. The Issues tab is the queue.

---

## What's not built (and why)

- **Playwright E2E** — deferred per TEST_STRATEGY.md. The smoke
  scripts cover end-to-end paths against real APIs; Playwright
  becomes worth it when the partner-facing UI grows beyond what a
  handful of integration tests can validate.
- **CMAC inbound webhooks** — we push and pull bookings, but CMAC
  pushing status updates back to us isn't wired. CMAC's webhook
  contract needs negotiating before this can land.
- **OAuth2 partner auth** — the H2 mapping engine supports
  `oauth2` as an auth mechanism but throws at runtime. We'll wire
  it the first time a partner requires it. Token caching + refresh
  is significant scope; not worth doing speculatively.
- **Multi-tenant team isolation** — would need Vercel Enterprise.
  Right now the platform serves a single network; multi-network
  routing is post-pilot.
- **Orphan webhook listener cleanup cron** — Frank's iCabbi-side
  project has this; we don't. Manual on-disconnect cleanup covers
  ~95% today.

---

## Tech stack

- **Frontend + API**: Next.js 15 (App Router) + TypeScript strict
- **DB**: Neon Postgres + Drizzle ORM
- **Auth**: Magic links via Resend, HMAC cookie sessions
- **Hosting**: Vercel (Pro, dedicated "The Exchange" team)
- **CI**: GitHub Actions (typecheck + vitest + docs-first)
- **Observability**: Sentry + structured logging

---

## Team

- **OG** — founder, commercial, product direction
- **Miro** — Contributor
- **Frank** — counterpart on the iCabbi side, integration partner
- Plus 5 persona subagent files (`/.claude/agents/`) that the team
  consults during reviews — Derek for design, Eamon for DevOps,
  Vicki for copy, Franko for spec, Bobby and Mykola for engineering
  depth.

---

## How to dig deeper

In order of how much time you have:

1. **30 seconds** — this doc.
2. **15 minutes** — `docs/PROJECT_OVERVIEW.md` (note: due a refresh
   — see Issues queue) and `CONTRIBUTING.md`.
3. **1 hour** — `docs/STRATEGY.md` (locked architectural decisions),
   `docs/specs/H2-mapping-layer.md` (Epic 3 design),
   `docs/CMAC_INTEGRATION.md` (worked example of partner onboarding).
4. **1 day** — clone, install, run `pnpm test:run`, then read every
   doc under `docs/` and trace one booking through the system from
   `POST /api/icabbi/bookings` to a transit row in the DB.
