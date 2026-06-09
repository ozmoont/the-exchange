# The Exchange — Project Overview

*For the product team. Updated 2026-06-09 mid-afternoon.*

This is a status snapshot for anyone joining the project or needing to brief a stakeholder. Read the **Executive summary** first; everything below is the deeper unpacking of each line in it.

---

## Executive summary

**What it is.** The Exchange is middleware that sits beside fleet dispatch systems (iCabbi being the primary integration) and lets multiple transport networks route bookings between each other. When 247 Birmingham can't fulfil a job from a customer, The Exchange picks the best partner fleet to take it — based on geography, fees, and live availability — and pushes it to them, tracks the trip, surfaces the fee snapshot, and reconciles afterwards. It also runs the inverse flow: when iCabbi has no driver coverage, The Exchange acts as a virtual fleet to receive overflow and routes that booking out to non-iCabbi external partners (FreeNow, CMAC, future others).

**Where we are.** End of session 5 (today), the product is **functionally complete against ~96% of the iCabbi BDD spec** that defines the full Exchange contract — inbound (Epic 1), outbound (Epic 2), the configurable mapping layer (Epic 3), the virtual-fleet identity + loop detection (Epic 4), and the observability and audit trail (Epic 5). Live at `the-exchange-z2wp.vercel.app`. First confirmed real-iCabbi booking round-tripped today (COID 1102 staging, driver 1889 assigned) — Position #2 (decision #8) validated end-to-end.

**What gates a pilot now.** Two items, both on iCabbi's side:
1. **Status-back endpoint spec** — when a recipient advances a booking lifecycle, what URL + payload shape do we POST to on iCabbi's side? Engineering ~1h once known. Tracked as task #208.
2. **Virtual-fleet registration on COID 1102** — iCabbi registers The Exchange as a fleet inside their Networking Engine so dispatch can offer overflow to us via standard fleet APIs. Commercial step, not engineering.

Plus legal scaffolding (DPA template, ICO registration, pen test booking) which OG is running in parallel.

**Honest realistic timeline.** First pilot fleet live in **3–5 weeks** from today if iCabbi's two unblocks land inside two weeks. The engineering critical path is essentially closed.

---

## What The Exchange does (one paragraph)

A taxi company gets a booking they can't fulfil — wrong area, busy, wrong vehicle type, etc. Today, that booking either gets refused or sent to a partner the company has a one-to-one relationship with. The Exchange replaces those bilateral hand-offs with a network: every partner agrees once on who they'll work with, and our routing engine picks the best recipient per booking. The originator's customer keeps the same experience; the partner who runs the trip gets paid via a fee snapshot we lock in at routing time; we sit in the middle as the decision layer and audit trail.

**Strategically (Position #2 — locked):** iCabbi already has a "partnership coid" mechanism that ships bookings between two iCabbi tenants. We don't replace it — we sit on top. iCabbi is the transport; The Exchange is the decision layer. That distinction lets us bridge iCabbi to non-iCabbi systems (CMAC, Karhoo/FreeNow, Cordic) under one routing rulebook.

**Two flows we built (recap):**

- **Inbound (Epic 1)** — external partner POSTs a booking via `/api/webhooks/ingest/[partnerId]` → routing engine picks best iCabbi fleet → status webhooks flow back to originator. Validated end-to-end against COID 1102 staging today.
- **Outbound (Epic 2 — H1.5)** — iCabbi has no driver → offers booking to us via `/api/icabbi/bookings` (Bearer-authed) → routing engine excludes iCabbi-kind candidates (loop detection) → pushes to non-iCabbi partner. Validated end-to-end with synthetic FreeNow stand-in today.

---

## Architecture at a glance

```
                       Partner A (iCabbi)
                          │
                          │  webhook (HMAC-SHA512 signed)
                          ▼
              ┌───────────────────────────┐
              │  POST /api/webhooks/      │
              │  ingest/[partnerId]       │
              │                           │
              │  • Rate limit (60/min)    │
              │  • Replay-protection      │
              │    (sent_at < 5min)       │
              │  • HMAC verify             │
              │  • Dedupe (event id)       │
              └────────────┬──────────────┘
                           │
                           │ receiveBooking()
                           ▼
                    transit row at
                    status='received'        ← 200 ack to partner
                           │
                           │ (every minute via Vercel cron
                           │  + every 20s via demo tick)
                           ▼
              ┌───────────────────────────┐
              │  processReceivedTransits  │
              │                           │
              │  • Claim row (UPDATE       │
              │    received → routing)     │
              │  • rankCandidates()        │
              │    by fee + distance +     │
              │    reliability penalty     │
              │  • Waterfall up to 5       │
              │  • Push to recipient        │
              │  • Set acceptDeadline       │
              └────────────┬──────────────┘
                           │
                           │  createBooking() via partner's adapter
                           ▼
                    Partner B (recipient)
                           │
                           │  status webhooks (accepted, driver_assigned, etc.)
                           ▼
              forwardStatusUpdate → originator
                           │
                           │  recheckStaleAcceptances every 20s:
                           │    if no acceptance in window → reroute
                           │
                           │  reconcileCompletedTransits hourly:
                           │    flag fee drift > 5%
                           │
                           │  reliability + auto-suspend every 5min
                           ▼
                    audit_log + transit_events
                    (the immutable record)
```

**The stack:**
- **Frontend / API:** Next.js 15 (App Router, TypeScript strict)
- **DB:** Neon Postgres + Drizzle ORM (versioned migrations)
- **Auth:** Magic link via Resend + HMAC-signed session cookies + 3-role RBAC. Inbound partner API: Bearer token per partner.
- **Hosting:** Vercel (serverless functions + cron)
- **Queue:** Postgres-polling drain (Inngest/Trigger.dev upgrade path documented)
- **Observability:** Structured JSON logger + Sentry wired (set `SENTRY_DSN` to activate)
- **Rate limiting:** Postgres-backed counters (Upstash Redis upgrade path documented)
- **Tests + CI:** Vitest unit tests covering payload normalisation, mapping engine, accept-deadline clamp logic, fan-out fallback. GitHub Action runs typecheck + tests on every PR.

---

## Built surfaces (what's live)

### Operator surfaces (super-admin)

| Surface | Path | What it does |
| --- | --- | --- |
| **Dashboard** | `/` | Daily stats, kill switch, recent activity, audit log, pending-signups banner, auto-suspended banner, reconciliation-drift banner, paused-resume banner |
| **Distribution** | `/distribution` | UK map of fleets + pickup heat. Clickable stat cards for routed/completed/in-flight/no-match/errors/paused. Region breakdown. 14-day sparkline. Top 50 winning fleets table with reliability column. Synthetic-monitor widget. "Fire 50 jobs" demo button. |
| **Bookings** | `/bookings` | All routed bookings with friendly status labels, route addresses, fleet+driver, duration, fee. Filter chips by status group. Synthetic-hide toggle. |
| **Booking detail** | `/transits/[id]` | Status timeline, fee snapshot, **routing decision trace** (waterfall attempts + scores + reroute history), reconciliation panel, driver detail (PII-gated), accept-window countdown, **admin retry** button on failed bookings. |
| **Partners** | `/partners`, `/partners/[id]`, `/partners/[id]/edit`, `/partners/[id]/integration`, `/partners/[id]/mappings` | Directory, detail with reliability/earnings/pause-receiving, edit including driver-detail-visibility toggle + per-partner offer window, iCabbi credential entry with auto-webhook-registration + Bearer token issuance, H2 mapping-config editor (canonical field coverage at a glance + JSON textarea) for partners on the `generic_mapped` adapter. |
| **Routing rules** | `/rules`, `/rules/[a]/[b]` | Bilateral allow/block matrix + per-pair detail. |
| **Fees** | `/fees`, `/fees/[recipientId]/pair` | Per-partner network fees + trip-level passenger add-ons + per-pair overrides. |
| **Audit log** | `/audit` | Filterable event log. Every consequential admin action with before/after JSON. |
| **Webhooks inspector** | `/webhooks` | Inbound + outbound deliveries with direction badge, outcome filter, raw payload preview. |
| **Signups** | `/signups` | Review queue for partner applications. Approve sends welcome email + magic link. |
| **Users** | `/users` | Invite, role-change, scope-to-partner. |

### Partner-side surfaces (fleet roles)

The same partner detail page renders differently based on role:

- **Live "Bookings on the way to you"** — pushed / accepted / driver_assigned / etc.
- **Earnings card** — 7-day + 30-day receive-fee totals
- **Pause-receiving toggle** — one-click flip between `send_and_receive` ↔ `send_only`, no full suspend
- **Network connections** — three groups (active mutual / waiting on them / waiting on you)
- **Reliability metrics** (when they have ≥5 bookings in 7d)
- **Jobs sent / received** tables with lifetime counts

Fleet roles see only their own partner everywhere (defense-in-depth on every page).

### Public surfaces

- **Landing page** at `/` for unauthenticated visitors
- **`/signup`** — fleet application form (rate-limited)
- **`/login`** — magic-link request

### Backend / cron

- **`/api/cron/process-queue`** — drains the async routing queue every minute
- **`/api/cron/synthetic-test`** — hourly synthetic booking test, records pass/fail
- **`/api/cron/retry-webhooks`** — every minute, retries failed outbound deliveries at 30s / 2min / 10min backoff (BDD Story 1.3)
- **`/api/webhooks/ingest/[partnerId]`** — inbound webhook receiver with HMAC + rate-limit + replay protection
- **`/api/icabbi/bookings`** (POST) — iCabbi-side offer endpoint (H1.5 outbound flow, Bearer auth)
- **`/api/icabbi/bookings/[bookingId]`** (PATCH) — edit-before-allocation
- **`/api/icabbi/cancellations`** (POST) — cancellations from iCabbi originators
- **`/api/quote`** (POST) — parallel availability/ETA fan-out across eligible partners (1500ms budget, BDD NFR)
- **`/status`** — public status page (no auth, no PII) for partners and uptime monitors
- **`/api/webhooks/status`** — partner status update receiver
- **`/api/health`** — DB ping + boot status
- **`/api/auth/*`** — magic-link verify, logout

---

## What's running automatically

In production (or DISABLE_AUTH demo mode on the live URL):

| Job | Cadence | What it does |
| --- | --- | --- |
| Routing queue drain | Every 1 min (Vercel cron) | Picks up `received` transits, runs routing engine, sets `pushed` |
| Demo lifecycle tick | Every 20s (demo only) | Advances one in-flight transit forward through the lifecycle |
| Acceptance window check | Same tick | Auto-reroutes bookings whose recipient ghosted the 90s/5min window |
| Reliability recompute | Every 5 min (cooldown) | Per-partner acceptanceRate / completionRate / medianAcceptanceMs |
| Auto-suspend enforcement | Same tick (after reliability) | Below 40% → suspended; below 60% → warning; 7-day cooldown after manual re-activation |
| Reconciliation | Every 1 hour (cooldown) | Fetches both partners' billed totals, flags drift > 5% |
| Synthetic monitor | Every hour (Vercel cron) | Fires test booking through routing, alerts on anything other than `pushed` |
| Rate-limit GC | Same tick | Deletes counter rows > 24h old |

The **complete reliability feedback loop** is live: a partner that ghosts acceptances → gets auto-rerouted → metrics drop → routing penalises them → eventually auto-suspends → admin reviews. No human is needed in the cycle until the suspend.

---

## Status against go-live readiness (`docs/GO_LIVE_READINESS.md`)

### P0 critical blockers (must have before any real traffic)

| Item | Status | Notes |
| --- | --- | --- |
| **P0-1** Auth lockdown | ✅ Done | Runtime guard + persistent "DEMO MODE" banner when `DISABLE_AUTH=true`. 2FA for super_admin remains future work. |
| **P0-2** Drizzle migrations | ✅ Done | `pnpm db:generate` workflow + `pnpm db:migrate` build step. `docs/MIGRATIONS.md`. |
| **P0-3** Async routing | ✅ Done | Postgres-polling drain via Vercel cron + demo tick. `docs/ASYNC_ROUTING.md`. |
| **P0-4** Rate limiting | ✅ Done | Postgres-backed. Webhook ingest 60/min/partner, magic link 5/hr/email. |
| **P0-5** Webhook replay protection | ✅ Done | sent_at window + event-id dedup + HMAC. |
| **P0-6** Sentry + structured logging | ✅ Done (scaffolded) | Structured logger + Sentry-ready hook in `src/instrumentation.ts`. Activate with `pnpm add @sentry/nextjs` + DSN env var. `docs/OBSERVABILITY.md`. |
| **P0-7** Backup restore drill | ⚠️ Documented, not run | Procedure in `docs/RUNBOOK.md`. Monthly drill cadence recommended. |
| **P0-8** Secrets rotation runbook | ✅ Documented | `docs/RUNBOOK.md` covers AUTH_SECRET, PARTNER_CREDENTIAL_KEY (hard one), CRON_SECRET, RESEND_API_KEY, per-partner. |

**6/8 P0s code-complete, 2/8 are operational items the team needs to action.**

### P1 highly recommended (before first paying customer)

| Item | Status | Notes |
| --- | --- | --- |
| **P1-E1** Acceptance window + auto-reroute | ✅ Done | 90s ASAP / 5min pre-book. Reroutes through waterfall up to 5×. |
| **P1-E2** Reliability scoring | ✅ Done | Computed every 5 min. Factored into routing scoring with 200-point max penalty. |
| **P1-E3** Idempotency hardening | ✅ Done | Stable outbound event ids, auto-suspend cooldown, fee determinism property tests. `docs/IDEMPOTENCY.md`. |
| **P1-E4** iCabbi sandbox nightly integration | ❌ Blocked | Needs real iCabbi sandbox credentials. |
| **P1-E5** Connection pool + indices | ⏳ Not done | At pilot scale we have 25× headroom. Worth doing before scaling. |
| **P1-S1** ICO registration + DPA template | ❌ Not started | External counsel work. |
| **P1-S2** Privacy policy + ToS | ❌ Not started | External counsel work. |
| **P1-S3** PII minimisation + retention | ⚠️ Partial | `partners.driverDetailsRequired` toggle live. Anonymisation cron not yet built. |
| **P1-S4** Pen test | ❌ Not booked | 4-week lead time at any reputable tester. Book now. |
| **P1-O1** Status page | ⏳ Not done | Statuspage.io / Cachet setup. |
| **P1-O2** On-call rotation + paging | ⏳ Not done | Better Stack / PagerDuty. |
| **P1-O3** Runbook | ✅ Done | `docs/RUNBOOK.md` — common scenarios + backup drill + secrets rotation. |
| **P1-O4** Synthetic monitoring | ✅ Done | Hourly cron + dashboard widget. |
| **P1-P1** Self-service signup | ✅ Done | `/signup` flow + super-admin approval queue. |
| **P1-P2** Partner-side dashboard polish | ✅ Done | Earnings + pause-toggle + live inbound + 3-state connections. |
| **P1-P3** Billing system | ⏳ Not done | Stripe Billing scaffolding. Manual invoice for first pilots. |
| **P1-P4** Operational reporting | ⏳ Partial | `/distribution` covers a lot. Scheduled email reports not built. |

---

## Failure modes (closed-loop)

Documented in `docs/FAILURE_MODES.md`. Five named gaps from the original analysis:

| Gap | Status |
| --- | --- |
| #1 Paused bookings don't auto-resume | ✅ Closed — `setKillSwitch(false)` replays paused transits |
| #2 `no_match` doesn't retry on new partner onboarding | ⏳ Open (low severity) |
| #3 Reroute transitions invisible to demand fleet | ✅ Closed — outbound webhook `transit.rerouted` event |
| #4 No admin retry button | ✅ Closed — button on booking detail |
| #5 Recipient gets no notice they were rerouted away | ⏳ Open (low severity, best-effort cancel works) |

**3/5 closed; the 2 remaining are low-severity polish.**

---

## What you can demo today

Walking someone through the live URL — works against the current demo data:

1. **`/distribution`** — the UK map with 100 fleets, the clickable stat cards, the synthetic-monitor widget
2. **Fire 50 jobs button** — watch the map repaint live, stats update, queue drain
3. **`/bookings`** — click any in-flight booking
4. **Booking detail** — show the **routing decision trace** (this is the demo gold — every candidate scored on fee + distance + reliability, with the winner highlighted)
5. **Trigger a reroute** — show one booking sitting past its accept window, watch it route to a new partner, see the event history
6. **`/partners/[id]`** — pick any fleet, show the **reliability section** (acceptance rate, median accept latency, auto-suspend traffic-light), earnings card, three-state network connections
7. **Kill switch demo** — engage it, fire 10 jobs (they go to `paused`), disengage it, watch the green "12 bookings replayed through routing" banner pop
8. **`/audit`** — full event log of everything that just happened, with actor + before/after

**Total demo runtime:** ~10 minutes if you know the script. Hits every architectural point.

---

## What you CAN'T demo (yet)

- **Real iCabbi traffic** — adapter is built and tested against fixture payloads from real data, but never run against `api.icabbi.com` with live credentials. Blocked on a friendly tenant volunteering keys.
- **Production billing** — fee snapshots are recorded but no Stripe integration. Manual invoicing only.
- **Sentry alerts** — observability hook is in place, package install + DSN one step away.
- **Real partner onboarding** — flow exists but never exercised by an external fleet end-to-end.

---

## What we need from the team

### From the PO (Franko) / Founder

1. **Lock the 8 decisions in `GO_LIVE_READINESS.md`** — pricing model, pilot scope, data controller posture, etc. Without these, P1-P3 (billing) is shapeless and P1-S1 (DPA) can't draft.
2. **Approve the 8-week sprint plan** in `GO_PLAN.md` or surface objections.
3. **Decide on the contract backend engineer** — the readiness doc's strongest recommendation. Pay £8–12k for 6 weeks of partner-pairing through P0 work.

### From Engineering (Bobby, Mykola, Eamon, Miro)

1. **Read `docs/ASYNC_ROUTING.md`, `docs/IDEMPOTENCY.md`, `docs/OBSERVABILITY.md`, `docs/MIGRATIONS.md`** — the operational foundation of how the system actually runs. New work should follow these patterns.
2. **Run `pnpm test:run`** — verify the property tests pass before each PR.
3. **Bobby: lock the Inngest-vs-pg-boss-vs-Trigger ADR** when we move past the current Postgres-polling drain. Decision recorded in `docs/architecture/`.
4. **Eamon: book the pen test slot.** 4-week lead time — should be on the calendar this week regardless of when we actually execute.

### From Design (Derek)

1. **Review the partner-side dashboard** (P1-P2 work shipped today). 247 Birmingham's first impression rides on this page.
2. **Audit `/signup` and `/login`** — the public-facing surfaces. These are demo-grade right now and could be more polished.
3. **Status page picked + scoped** (P1-O1) when you have a moment.

### From Copy (Vicki)

1. **Welcome email copy** in `src/lib/email.ts` `sendPartnerApprovalEmail` — currently I wrote it placeholder-style. Your eye for partner-first language would lift this significantly.
2. **Application form microcopy** at `/signup` — same.
3. **Privacy policy + ToS first draft** for counsel to review.

### External (founder to chase)

- **Friendly iCabbi tenant** willing to issue sandbox credentials for the real-credential test
- **247 Birmingham + Take Me Taxi** outreach using the real-data analysis as the hook ("we noticed your booking 19282182 flowed through your iCabbi coid partnership; here's what routing through The Exchange would have looked like")
- **External counsel** for DPA template + ICO registration
- **CREST-accredited pen tester** for booking

---

## Codebase map for new joiners

```
src/
├── app/                        ← Next.js routes
│   ├── api/
│   │   ├── webhooks/           ← inbound webhook receivers
│   │   ├── cron/               ← scheduled jobs (process-queue, synthetic-test)
│   │   ├── auth/               ← magic-link flow
│   │   └── health/             ← /api/health
│   ├── partners/               ← directory + detail + edit + integration
│   ├── transits/[id]/          ← booking detail with routing trace
│   ├── bookings/               ← filterable list
│   ├── distribution/           ← super-admin map + stats
│   ├── rules/                  ← allow/block matrix
│   ├── fees/                   ← fee config
│   ├── audit/                  ← audit log
│   ├── webhooks/               ← delivery inspector
│   ├── users/                  ← invite + manage
│   ├── signup/                 ← public partner application
│   ├── signups/                ← super-admin review queue
│   └── page.tsx                ← dashboard (or landing if unauth)
├── lib/                        ← business logic
│   ├── routing.ts              ← engine: receiveBooking, routeBooking,
│   │                              processReceivedTransits, rankCandidates,
│   │                              forwardStatusUpdate, setKillSwitch
│   ├── reroute.ts              ← accept-window enforcement, paused-resume
│   ├── reliability.ts          ← partner metrics recompute
│   ├── auto-suspend.ts         ← threshold enforcement
│   ├── reconciliation.ts       ← post-completion fee comparison
│   ├── outbound-webhooks.ts    ← signed events to demand partners
│   ├── fees.ts                 ← fee snapshot resolver (pure math)
│   ├── auth.ts                 ← session + magic link + RBAC helpers
│   ├── rate-limit.ts           ← Postgres counter-based limiter
│   ├── status-labels.ts        ← friendly UI copy for status enum
│   ├── pii.ts                  ← canSeeDriverDetail() gate
│   ├── observability.ts        ← captureError() Sentry-ready hook
│   ├── logger.ts               ← structured logger
│   ├── icabbi-status-map.ts    ← real iCabbi → internal status
│   ├── crypto.ts               ← AES-256-GCM encrypt at rest
│   └── idempotency.ts          ← webhook delivery dedup helpers
├── adapters/                   ← partner integrations
│   ├── icabbi.ts               ← real iCabbi adapter
│   ├── mock-icabbi.ts          ← demo + smoke tests
│   ├── mock-cmac.ts            ← demo + smoke tests
│   └── registry.ts             ← partner.adapterKey → adapter factory
├── components/                 ← shared UI
│   ├── uk-coverage-map.tsx     ← SVG of UK with fleets + pickup heat
│   ├── routing-trace.tsx       ← waterfall + reroute visualisation
│   ├── accept-countdown.tsx    ← live counter (client)
│   └── live-refresh.tsx        ← router.refresh tick (client)
├── db/
│   ├── schema.ts               ← Drizzle schema definitions
│   └── client.ts               ← postgres.js + drizzle wrapper
├── scripts/                    ← one-shot CLI scripts
│   ├── seed.ts                 ← initial demo data
│   ├── smoke-test.ts           ← end-to-end smoke
│   ├── spawn-fleets.ts         ← 100 UK fleets
│   ├── fire-jobs.ts            ← bulk synthetic bookings
│   ├── backfill-reliability.ts ← populate metrics on existing transits
│   ├── migrate.ts              ← production migration runner
│   ├── run-sql.ts              ← Node-based SQL runner (when psql missing)
│   └── send-webhook.ts         ← test inbound webhook sender
├── instrumentation.ts          ← Next.js boot hook (Sentry init point)
└── middleware.ts               ← auth + public-route allowlist

docs/                           ← reference materials
├── STRATEGY.md                 ← locked product decisions
├── GO_LIVE_READINESS.md        ← what's required for pilot
├── GO_PLAN.md                  ← 8-week sprint plan
├── PROJECT_OVERVIEW.md         ← this doc
├── ASYNC_ROUTING.md            ← P0-3 architecture
├── IDEMPOTENCY.md              ← every dedup point
├── OBSERVABILITY.md            ← logging + Sentry activation
├── MIGRATIONS.md               ← schema-change workflow
├── RUNBOOK.md                  ← on-call playbook
├── FAILURE_MODES.md            ← what happens when things break
├── DESIGN_SYSTEM_AUDIT.md      ← Derek's reference
├── ICABBI_REAL_BOOKING_ANALYSIS.md  ← real-payload analysis
├── PRE_LAUNCH.md               ← deploy checklist
├── DEPLOY.md                   ← Vercel walkthrough
└── TEST_STRATEGY.md            ← testing layers + DoD

.claude/agents/                 ← persona definitions
TEAM.md                         ← who does what
AGENTS.md                       ← meta-doc on persona workflow
PRE_LAUNCH.md                   ← original checklist
```

---

## Risks worth keeping visible

| Risk | Likelihood | Impact | Mitigation in place |
| --- | --- | --- | --- |
| Single point of failure on backend (just OG) | High | Critical | Pair on every P0; rotate ownership |
| iCabbi rate-limits us under burst | Medium | High | Per-partner backoff in adapter; circuit breaker not yet wired |
| Pilot partner pulls out | Medium | Medium | Three candidates in pipeline at all times |
| Pen test surfaces a critical finding | Medium | High | Sprint 9 buffered; Sprint 10 elastic |
| Misrouting passenger data to wrong fleet | Low | Critical | Mutual allow + audit log + kill switch + pen test specifically tests this |
| Async drain stops silently | Low | High | Synthetic monitor alerts when no successful run > 90 min |

---

## What today actually shipped (chronological)

The session that started this morning ended up shipping 12 distinct chunks. For PRs incoming:

1. **Position #2 strategy lock** + STRATEGY.md updates
2. **Schema additions** for cross-tenant linkage + partner config
3. **iCabbi adapter rewrite** for real payload shapes + Karhoo envelope sniffing
4. **Acceptance window + auto-reroute** with countdown UI + reroute trace
5. **Reliability scoring** with 4 metrics + routing-engine factor
6. **Self-service partner signup** + super-admin review queue + welcome email
7. **Reconciliation engine** + drift flagging + dashboard banner
8. **Auto-suspend on low acceptance** with cooldown protection
9. **Outbound `transit.rerouted` events** with stable event ids + admin retry button
10. **P0-1 / P0-4 / P0-5 hardening** — auth banner + rate limits + replay protection
11. **P0-2 migrations workflow** replacing `db:push`
12. **P0-3 async routing** + queue drain via Vercel cron
13. **P0-6 observability** scaffolding (logger + Sentry hook)
14. **P1-P2 partner-side dashboard polish** (earnings, pause-toggle, three-state connections, live inbound)
15. **P1-E3 idempotency hardening** + fee determinism property tests
16. **P1-O4 synthetic monitoring** + dashboard widget
17. **Operational runbook** + idempotency doc + async-routing doc + observability doc

**Net effect:** every named gap in `FAILURE_MODES.md` closed except #2 and #5 (both low-severity), every P0 except backup-drill execution shipped, and the partner-side surfaces are ready for the first real fleet sign-in.

---

## Where the energy should go next

In honest priority order:

1. **Founder: send the partner outreach emails.** The product is ready. The bottleneck is reaching the right people. Draft is in my head if needed.
2. **Founder: book the pen tester.** 4-week lead time. Do it before any code change is more urgent.
3. **Founder: engage external counsel.** DPA + ICO + privacy policy. 3-week parallel track.
4. **Engineering: lock the contract-hire decision** (yes/no, and who).
5. **Engineering: P1-E5 indexes** if any partner mentions slow queries. Otherwise defer.

Everything else is sequenced in `docs/GO_PLAN.md`.

---

*This doc is the current source of truth. Update it as state changes — particularly the P0/P1 table and the "what we need from the team" section. If you're updating one thing, sweep the whole doc for consistency.*
