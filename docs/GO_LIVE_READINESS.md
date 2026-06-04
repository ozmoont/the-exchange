# Go-Live Readiness Plan — The Exchange

*Author: PO  ·  Last updated: 2026-05-29  ·  Owner of this doc: PO*

---

## TL;DR

The Exchange has a working MVP on Vercel + Neon, demo data loaded, and one production-grade integration target (iCabbi). To accept real fleet traffic — meaning passenger PII, real money flowing through fee snapshots, and SLAs on routing latency — we need approximately **6–8 weeks** of structured work before the first pilot fleet goes live, and a further **30 days post-pilot** before scaling beyond 5 partners.

Five things will block go-live and must land first. Everything else is sequenceable.

1. **`DISABLE_AUTH=true` must be off in prod and stay off.** Demo mode treats every visitor as `super_admin`. Today this is fine because nobody real is on the URL. Day 1 of a pilot it is a P0 incident waiting to happen.
2. **Replace `drizzle-kit push` with proper migrations.** `push` is destructive — a column rename in dev would drop data in prod. We need `drizzle-kit generate` + `migrate` and a migration runner in the deploy step.
3. **Move routing off the request path.** Today `routeBooking()` runs synchronously inside an HTTP request. A slow recipient adapter blocks the originator's webhook ack, which makes iCabbi retry, which causes duplicates. Needs to be queue-backed.
4. **Rate limit every public endpoint.** No limits exist. A single misbehaving partner could DOS the entire network.
5. **Webhook replay protection.** HMAC ✓ but no timestamp window or nonce check. A captured webhook can be replayed indefinitely.

Beyond those five, the plan below organises everything into four parallel streams (Engineering, Security & Compliance, Operations, Product) with priority bands.

---

## Decisions needed from sponsor before plan is locked

These materially affect scope. Defaults assumed in the rest of this doc are in *italics*.

1. **Pricing model**: per-routed-job, per-completed-trip, or monthly subscription? *Per-completed-trip, with a small per-routed surcharge to discourage no-shows.*
2. **Pilot scope**: how many fleets, which cities, target volume? *3–5 fleets in Greater London for the pilot; ~1,000 jobs/day combined ceiling.*
3. **Money flow**: do we touch passenger fares, or only invoice the receiving fleet for our network fee? *Invoice the recipient monthly; never hold passenger money. This avoids FCA money-transmitter scope.*
4. **Data controller posture**: are we joint controllers with the originator, or pure data processor? *Pure processor — originators control passenger data, we move it under their instructions.*
5. **Insurance**: who insures the trip? *The recipient fleet's existing PHV operator insurance — contractually their responsibility, restated in our partner agreement.*
6. **Geographic scope at GA**: UK only, or UK + Ireland? *UK only for first 12 months. Re-enable Irish regions only after Irish licensing is reviewed.*

If sponsor disagrees with any default, several items below shift category.

---

## P0 — Critical blockers (cannot accept any real partner traffic)

These are non-negotiable. None of them are large individually; collectively they are 2–3 weeks of focused engineering.

### P0-1. Lock down auth in production
- Remove `DISABLE_AUTH` env var from production. Keep it for `preview` deploys only, with a banner if active.
- Add a runtime assertion in `src/lib/auth.ts`: throw if `NODE_ENV === "production"` and `DISABLE_AUTH === "true"`.
- Add 2FA (TOTP) for `super_admin` accounts. Magic link alone is fine for fleet users; admin actions touching kill switch, fees, and credentials need a second factor.
- Session expiry: today 14 days. Drop to 12 hours for `super_admin`, 7 days for fleet roles.
- Add session list / revoke UI on `/users`.
- **Effort:** 3 days. **Owner:** Backend.

### P0-2. Proper database migrations
- Switch from `drizzle-kit push` to `drizzle-kit generate` workflow.
- Commit migration SQL files to `drizzle/migrations/`.
- Run migrations in CI before deploy, not on first request.
- Tag every migration with a description and ticket reference.
- Add a smoke migration test in CI that applies migrations to a fresh DB and runs `pnpm smoke`.
- **Effort:** 2 days. **Owner:** Backend.

### P0-3. Async routing
- Today `POST /api/webhooks/ingest/[partnerId]` synchronously calls `routeBooking()`, which may chain HTTP requests to up to 5 candidate adapters (waterfall × MAX_WATERFALL). A 10s outbound call holds the originator's webhook open.
- Move to: receive → enqueue → 200 immediately → background worker drains queue → routes → sends status webhook back to originator.
- Recommended: Inngest or Trigger.dev (both have Vercel-native deploys and free tiers). Postgres-backed queue (e.g. `pg-boss`) is also viable and one less vendor.
- Side effect we want: webhook delivery to partners also becomes async-with-retry, which gets us idempotent delivery and a retry budget per-partner.
- **Effort:** 8 days. **Owner:** Backend. **Dependencies:** P0-6 (error tracking — debugging async is hell without it).

### P0-4. Rate limiting
- Per-IP and per-partner-credential limits on `/api/webhooks/ingest/*`.
- Per-user limits on `/api/auth/login` (magic link request) and any admin-write route.
- Recommended: Upstash Redis + `@upstash/ratelimit`. Single env var, edge-runtime compatible.
- Limits to start: 60 webhook ingestions per partner per minute (real iCabbi traffic is well under this); 5 magic link requests per email per hour; 20 admin writes per user per minute.
- 429 responses should include `Retry-After`.
- **Effort:** 2 days. **Owner:** Backend.

### P0-5. Webhook replay protection
- Today `verifyHMAC()` checks the signature but not when the request was sent.
- Add a Karhoo-style `sent_at` field check: reject anything more than 5 minutes old.
- Persist webhook event IDs in a small table for 24h; reject duplicates.
- This stops both replay attacks and the more common case of broken partner clients re-sending the same event in a tight loop.
- **Effort:** 1.5 days. **Owner:** Backend.

### P0-6. Error tracking + structured logging
- Wire up Sentry (`@sentry/nextjs`). All unhandled exceptions, all `routeBooking()` failures, all webhook signature mismatches.
- Replace `console.log` and `console.warn` with a structured logger (`pino` works well in Next 15). Every log line should carry `transit_id`, `partner_id`, `request_id`.
- Alert routing: P0 errors → PagerDuty; everything else → a `#exchange-errors` Slack channel.
- **Effort:** 2 days. **Owner:** Backend.

### P0-7. Backup + restore drill
- Neon does automated point-in-time recovery, but we have not tested it.
- Once before launch, restore a Neon branch from yesterday, point a preview deploy at it, verify the app boots and reads data.
- Document the procedure in `docs/RUNBOOK.md`.
- **Effort:** 1 day. **Owner:** Backend.

### P0-8. Production secrets rotation runbook
- Document how to rotate `AUTH_SECRET`, `PARTNER_CREDENTIAL_KEY`, individual partner API keys.
- `PARTNER_CREDENTIAL_KEY` rotation is the hard one: re-encrypts every row in `partners.credentials`. Write the migration script now, run it once as a dry-run.
- **Effort:** 2 days. **Owner:** Backend.

**P0 total: ~3 weeks of one strong backend engineer.**

---

## P1 — High priority (before first paying customer)

Everything in P1 can land in parallel with the pilot if necessary, but should be done before billing starts.

### Engineering

#### P1-E1. Acceptance window + reroute
Today `routeBooking()` treats the recipient adapter's `createBooking` 200 as "fleet is committed". In reality the fleet's dispatcher might never assign a driver — the booking sits in `pushed` forever. Build:

- A configurable acceptance window (default 90s ASAP, 5 min pre-book).
- A scheduled job that scans for `pushed` transits older than the window and re-routes to the next candidate.
- Track per-partner acceptance rate as a routing input (see Reliability scoring below).

**Effort:** 4 days. **Owner:** Backend.

#### P1-E2. Reliability scoring
Routing currently scores on `fee + distance × 5p/km`. Add a third term: `reliability_penalty`, computed nightly per partner from:
- Acceptance rate (last 7 days)
- Completion rate (last 7 days)
- Median acceptance latency

Partners below threshold (e.g. <85% acceptance) get deprioritised. Below floor (<60%) get auto-suspended with admin notification.

**Effort:** 5 days. **Owner:** Backend.

#### P1-E3. Idempotency hardening
- Every adapter call must be idempotent. Verify iCabbi's `POST /v2/bookings` is idempotent by external id (it should be, but confirm with their team and add integration test).
- Every webhook handler must dedupe on `event_id`.
- Every fee calculation must be deterministic given the same inputs (it is; lock this down with a property test).

**Effort:** 3 days. **Owner:** Backend.

#### P1-E4. End-to-end integration test against iCabbi sandbox
- Real adapter, real HTTPS calls, real webhook delivery in both directions.
- Runs nightly on a dedicated sandbox tenant.
- Failures wake on-call.

**Effort:** 4 days. **Owner:** Backend.

#### P1-E5. Connection pooling + query optimisation
- Confirm Neon connection pool is sized for our serverless function concurrency. Today we use the default which is likely under-provisioned for spikes.
- Audit slow queries; the routing path does `N + M` queries today (one fee resolution per candidate). Batch.
- Add EXPLAIN ANALYZE on the top 10 queries.
- Add Postgres indices on: `transits(originator_partner_id, status, created_at)`, `transit_events(transit_id, created_at DESC)`, `audit_log(category, created_at DESC)`.

**Effort:** 3 days. **Owner:** Backend.

### Security & Compliance

#### P1-S1. ICO registration + DPA template
- Register The Exchange as a UK data controller / processor with the ICO (£40–60/year).
- Draft a Data Processing Agreement template that we'll sign with each partner. Critical clauses: sub-processor list, data residency (EU), breach notification window (72h), audit rights, return/deletion on termination.
- Stand up a `privacy@the-exchange.io` mailbox and respond-within-30-days commitment for data subject rights.
- **Effort:** 1 week (mostly legal). **Owner:** PO + external counsel.

#### P1-S2. Privacy policy + terms of service
- Public-facing pages on the marketing site.
- Cookie policy (we use one session cookie; nothing else; declare it).
- Acceptable use policy for partners.
- **Effort:** 3 days drafting + 1 week external review. **Owner:** PO + counsel.

#### P1-S3. PII minimisation audit
The `NormalisedBooking.passenger` field carries `{ name, phone }`. Both are PII.
- Audit every place the booking payload is stored or logged. Confirm we never log full payload.
- Define a retention policy: completed bookings keep PII for 90 days, then anonymise (replace `name`/`phone` with `redacted` hash). Aggregate stats survive.
- Build the anonymisation job (daily cron, can use the same scheduled-task infra as acceptance reroute).
- **Effort:** 3 days. **Owner:** Backend.

#### P1-S4. Penetration test
- Engage a CREST-accredited tester for a 5-day pen test before pilot.
- Scope: auth, webhook endpoints, RBAC enforcement, credential handling, IDOR on partner detail pages.
- Budget: £8k–£15k.
- **Effort:** 2 weeks lead time + 1 week remediation. **Owner:** PO to engage; Backend to fix findings.

#### P1-S5. Secrets management discipline
- Move from Vercel env vars to a dedicated secrets manager (Doppler, Infisical, or 1Password Secrets Automation). Vercel env is fine but doesn't give us scoped access for engineers vs sub-processors.
- Quarterly rotation cadence documented.
- **Effort:** 2 days. **Owner:** Backend.

### Operations

#### P1-O1. Status page
- statuspage.io or a self-hosted Cachet. Public component for each subsystem (Routing, Webhooks Inbound, Webhooks Outbound, Partner Adapters).
- Linked from the login page.
- On-call updates it during incidents.
- **Effort:** 1 day. **Owner:** Ops.

#### P1-O2. On-call rotation + incident response
- Two-person rotation, weekly handover.
- PagerDuty (or Better Stack — cheaper).
- Severity definitions (SEV-1 routing outage / SEV-2 partial degradation / SEV-3 cosmetic).
- Incident commander role defined.
- Blameless postmortem template in `docs/incidents/`.
- **Effort:** 1 day setup + ongoing time commitment. **Owner:** Engineering lead.

#### P1-O3. Runbook
A document in `docs/RUNBOOK.md` covering, with copy-pasteable commands:
- "A partner says they're not receiving jobs" — how to debug
- "A partner says their webhooks are 401-ing" — credential rotation procedure
- "Routing is slow" — query log review
- "Kill switch needs to be engaged" — who calls it, who's notified
- "Backup restore needed" — full procedure including DNS cutover
- "How to manually re-route a stuck booking"
- **Effort:** 3 days. **Owner:** Backend + Ops.

#### P1-O4. Synthetic monitoring
- Hourly script that fires one test booking through the smoke partner pair and verifies it reaches `completed` (or whatever happy-path equivalent we land on for synthetics).
- Alert on failure.
- **Effort:** 2 days. **Owner:** Backend.

### Product

#### P1-P1. Partner self-service onboarding flow
Today new partners are added by `super_admin` via UI form. Pilot will need:
- `/signup` page where a prospective partner enters fleet details
- Application review queue for super_admin
- On approval, partner receives magic link to set up credentials themselves
- Welcome email sequence (via Resend, signed-up domain)
- **Effort:** 5 days. **Owner:** Frontend + Backend.

#### P1-P2. Partner-side dashboard polish
Fleet users today see a read-only partner detail page. They need:
- Live "Jobs you're receiving right now" view with driver assignment quick action
- Earnings statement for the current period
- Their own routing rules (allow/block) view
- A "Pause receiving" toggle that engages only for them
- **Effort:** 5 days. **Owner:** Frontend.

#### P1-P3. Billing system
- Stripe Connect or simple monthly invoicing via Stripe Billing.
- Invoice line = sum of `feeSnapshot.receiveFeePence` for transits where `status='completed'` in the period.
- Tax: VAT for UK partners (we're VAT-registered? PO decision needed).
- Dispute flow: partner can flag a transit fee for review; we suspend invoicing of that line until resolved.
- **Effort:** 8 days. **Owner:** Backend + Finance.

#### P1-P4. Operational reporting
Super admins need scheduled reports:
- Daily: routing volume, success rate, top failures
- Weekly: per-partner scorecards
- Monthly: revenue, churn, time-to-accept distribution
Email + downloadable CSV.
- **Effort:** 4 days. **Owner:** Backend.

**P1 total: ~5 weeks distributed across 2 engineers, PO and Ops.**

---

## P2 — Medium priority (first 30 days post-pilot)

### Engineering
- **Postgres read replica** for `/distribution`, `/audit`, reporting queries. Reduces primary load.
- **Caching layer** (Redis): hot reads on `partners` table (every routing call hits it), feeConfigs (every routing call hits it). 30s TTL is fine.
- **Multi-region failover.** Today single Vercel region, single Neon region. After 50+ partners we should at least be able to fail Neon over manually. Reach for Neon's read replicas in EU-West.
- **Webhook delivery dead letter queue.** Failed deliveries to partner endpoints today go to `webhook_deliveries` with `outcome='failed'`. Build a UI to inspect, retry, or mark as abandoned.
- **Auto-suspended partner re-onboarding flow.** If we suspend a partner for low acceptance, they need a way back.
- **Adapter versioning.** Adapter interface change shouldn't require simultaneous deploy across all partners.

### Security
- **SOC 2 Type I readiness.** Probably 6+ months of evidence collection, but start logging the controls now (change management, access review, vendor management). Vanta or Drata as the platform.
- **Vendor risk assessments.** Standard form for every sub-processor (Neon, Vercel, Resend, Stripe, Sentry, etc.). Refresh annually.
- **Annual pen test cadence locked in.**

### Operations
- **Customer support tooling.** Intercom or Zendesk; partner support requests get triaged here.
- **Metrics dashboards.** Beyond `/distribution`: latency percentiles for routing, p50/p95/p99 of acceptance time, fee revenue trend. Grafana fronting Postgres + Sentry.
- **Quarterly disaster recovery drill.**

### Product
- **Multi-adapter support.** Today only iCabbi has a real adapter. CMAC, Autocab, Cordic are obvious next targets. Each ~3 weeks of work.
- **Pricing model experiments.** Currently flat receive fee per booking. Try percentage-of-fare for executive class.
- **API for partners to push us bookings programmatically** (without going through iCabbi adapter). Some partners will want this.
- **Refund / cancellation flow** with rules for who pays the cancellation fee.

---

## P3 — Lower priority / backlog

These would be nice but don't block growth.

- Mobile app (driver / dispatcher quick-look)
- Multi-language support
- White-label deployments
- Cross-network passenger app
- ML-based driver-supply forecasting for routing scoring
- Integrated chat between dispatchers across the network
- Carbon-cost tracking per trip

---

## Operating principles

These should be true on the day of go-live and stay true.

1. **Every change to a partner's config is in the audit log with actor, before, after, and reason.** Today this works; preserve it.
2. **Kill switch is one click and stops new routing in under 5 seconds.** Test this monthly.
3. **No engineer has standing access to passenger PII in production.** Read access is granted on a justified, time-boxed basis through a documented procedure.
4. **Every outbound HTTP call is logged with destination, request size, response status, latency.** Costs us pennies via Sentry; saves us days during incidents.
5. **A new partner cannot route to / from anyone without explicit super_admin approval of mutual allow rules.** Don't ever auto-mutual-allow in production — that was a demo-only convenience.

---

## Sequencing — 8-week pre-pilot plan

| Week | Engineering | Security | Ops | Product |
| --- | --- | --- | --- | --- |
| 1 | P0-1 auth lockdown, P0-6 Sentry | DPA template draft | — | — |
| 2 | P0-2 migrations, P0-4 rate limits | P0-5 replay (joint) | — | — |
| 3 | P0-3 async routing (start) | ICO registration | P1-O1 status page | — |
| 4 | P0-3 async routing (finish), P0-7 backup drill | Pen test prep | P1-O2 on-call setup | P1-P1 signup flow (start) |
| 5 | P1-E1 acceptance window, P1-E5 query opt | Pen test executes | P1-O3 runbook | P1-P1 signup flow (finish) |
| 6 | P1-E3 idempotency, P1-E4 sandbox tests | Pen test remediation | P1-O4 synthetics | P1-P2 partner dashboard |
| 7 | P1-E2 reliability scoring | P1-S3 PII audit + retention job | DR drill | P1-P3 billing (start) |
| 8 | Buffer / launch prep | Final security review | Go/No-go meeting | P1-P3 billing (finish) |

---

## Go / No-go criteria for first pilot

Before flipping the switch on first paying partner, all of these are true:

- [ ] All P0 items complete and signed off.
- [ ] Pen test report received, all High and Critical findings remediated.
- [ ] DPA executed with pilot partner(s).
- [ ] Runbook published and walked through by entire on-call rotation.
- [ ] Status page live with all components green.
- [ ] Synthetic monitoring passing for 14 consecutive days.
- [ ] One full DR drill completed (backup restore, traffic cutover).
- [ ] ICO registration confirmed.
- [ ] Insurance review confirmed responsibility model holds (PHV operator insurance on receiving fleet).
- [ ] Sponsor sign-off on pricing model.
- [ ] First invoice template generated and reviewed.

If any item is unchecked, we delay. There is no version of "we'll fix it after launch" that ends well in a regulated industry.

---

## Risks

Top five risks and our mitigations.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Misrouting a booking sends passenger data to wrong fleet | Low | Critical | Strict mutual allow + audit log + kill switch; pen test specifically tests this |
| iCabbi rate limits us during peak | Medium | High | Per-partner backoff in adapter; circuit breaker; status page banner |
| Pilot partner refuses our DPA terms | Medium | Medium | Have counsel ready; identify which clauses are negotiable in advance |
| Acceptance rate is structurally low (drivers ignore new-network jobs) | Medium | High | Build acceptance window + auto-reroute (P1-E1); priority lists per area |
| One-person bus factor on backend | High | Critical | Pair on every P0 item; rotate ownership across P1; document everything in runbook |

---

## Anti-goals

Things we are deliberately not doing for go-live, with reasoning. These come up in every kickoff conversation and we should be ready to defend the no.

- **No driver app.** The recipient fleet's own dispatcher app is the driver's interface. We are middleware, not a consumer brand.
- **No passenger-facing UI.** Same reason. Originator owns passenger relationship.
- **No payment processing of passenger fares.** Brings FCA scope; we don't need it for the network fee model.
- **No multi-currency for go-live.** UK only, GBP only.
- **No ratings / reviews.** Each fleet has their own.
- **No surge pricing logic.** That's the originator's product surface.
- **No public API at go-live.** Adapters are the surface; opening an unauthenticated public API is a security review we don't have time for.

---

## Open questions for the sponsor

These need answers before week 1 of the plan starts.

1. What's the agreed pilot fleet count and which cities?
2. Are we VAT-registered yet? Affects invoicing setup.
3. Who is the engineering lead post-launch?
4. Who is on call rotation #1?
5. Budget for pen test, insurance, ICO, legal counsel?
6. Do we want a separate brand for the marketing site or live on `the-exchange-z2wp.vercel.app`?
7. Acceptable downtime SLA to commit to? (Recommend 99.5% to start — gives us ~3.6 hours/month, achievable on Vercel + Neon.)

---

## Out of scope for this document

This plan covers go-live readiness. The following are tracked separately:

- Engineering hiring plan (separate doc with eng lead)
- Marketing launch plan (PO + marketing)
- Sales pipeline for partners 6–20 (sales doc)
- Competitive positioning (strategy doc)
- Pricing model deep-dive (commercial doc)

---

*Comments and challenges welcome. Edit this doc directly via PR; don't make commitments based on it without sponsor sign-off.*
