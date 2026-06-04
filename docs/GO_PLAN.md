# The Exchange — Go-Live Plan

*Working sprint plan from kickoff to first pilot. Pairs with `GO_LIVE_READINESS.md` for full rationale.*

*Author: PO  ·  Last updated: 2026-05-29  ·  Sprint length: 1 week, Mon → Fri  ·  Standup: 09:30 daily*

---

## Plan at a glance

- **Kickoff**: Monday 2026-06-02
- **Pen test executes**: Week 8 (2026-07-21)
- **Soft launch (1 fleet, controlled volume)**: end of Week 12 (2026-08-22)
- **First paying customer with SLA**: Week 14 (2026-09-05)
- **Total elapsed**: 12 weeks engineering + 2 weeks pilot stabilisation

This plan assumes the AI persona team (Andy/Bobby/Mykola/Miro/Derek/Eamon/Vicki) executes engineering, with OG owning all external human stakeholders (legal counsel, pen tester, iCabbi commercial team, pilot fleet operators, insurance broker, bookkeeper). If a paid contract backend engineer joins by Week 2, the timeline compresses by ~3 weeks; defer that decision to the kickoff.

---

## Week 0 — Kickoff (today + Friday)

### Friday 2026-05-30

OG completes before end of day:

1. Read this plan and `GO_LIVE_READINESS.md` end to end.
2. Answer the eight decisions in the readiness doc (pricing, pilot scope, money flow, data controller posture, insurance, geo, VAT, SLA). Write the answers into `docs/STRATEGY.md` — that file is the source of truth for locked decisions.
3. Draft a 1-page note to send to iCabbi commercial contact asking about sandbox tenant + integration certification timeline.
4. Identify 3 candidate pilot fleets. For each: contact name, fleet size, why they'd want this. One-liner each.

### Monday 2026-06-02 — Kickoff meeting (60 min, async-friendly)

Agenda:

1. (5 min) State of the codebase: where we are, what's live at `the-exchange-z2wp.vercel.app`.
2. (10 min) The five P0 blockers. Confirm nobody disagrees this is the order.
3. (15 min) Decisions review from `STRATEGY.md`. Anything still open gets a date by which it must close.
4. (10 min) Resourcing: do we hire a contract backend engineer? Decision today, not later.
5. (10 min) External vendor selection: which pen tester, which legal counsel, which secrets-manager. OG to chase quotes this week.
6. (10 min) Pilot partner conversations — who reaches out to whom, by when.

Decisions logged in `docs/decisions/2026-06-02-kickoff.md` immediately after.

---

## Sprint cadence

- **Mon 09:30** — Sprint planning. Pick items from the plan, write specs (Andy) for anything ambiguous.
- **Daily 09:30** — Standup: yesterday / today / blocked. Five minutes hard cap.
- **Wed 14:00** — Mid-sprint check. If we're behind, descope now, not Friday.
- **Fri 16:00** — Sprint review. Miro signs off on done items per DoD. Anything not signed off rolls to next sprint with an explicit note.
- **Fri 17:00** — Sponsor update sent (email or Slack — OG drafts).

**Definition of Done** is enforced by Miro and lives in `AGENTS.md`. No item is "done" because the engineer says so — only after Miro signs.

---

## Sprint 1 · Week of 2026-06-02 — Lock down auth + observability

Goal: nothing in production runs without auth and we see every error.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P0-1 | Auth lockdown + super-admin 2FA | Mykola | Andy | DISABLE_AUTH guard; TOTP enrolment for super_admin; session expiry tuned | Miro |
| P0-6 | Sentry + structured logging | Mykola | — | All unhandled errors → Sentry; pino logger; request_id propagated | Miro |
| P0-1.5 | Runtime production safety assertion | Eamon | Andy | Boot-time check: `NODE_ENV=production && DISABLE_AUTH=true` throws | Miro |

OG in parallel:

- Engage external counsel (write a 1-paragraph brief).
- Engage pen tester (book Week 8 slot now — earliest slot at any reputable tester).
- Open ICO data controller registration (£40–60).
- Reach out to candidate pilot fleet #1 with intro email.

**Risk this sprint**: Sentry quota — start on free tier, set alert when 80% used.

---

## Sprint 2 · Week of 2026-06-09 — Migrations + abuse prevention

Goal: production schema changes are reversible and we cannot be DOSed.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P0-2 | Drizzle migrations (replace `push`) | Eamon | Andy | `drizzle/migrations/` committed; CI runs migrations pre-deploy | Miro |
| P0-4 | Rate limiting (Upstash) | Mykola | Andy | All webhook + auth + admin write routes rate-limited; 429s include `Retry-After` | Miro |
| P0-5 | Webhook replay protection | Mykola | Andy | `sent_at` window + event-id dedup table; replays return 409 | Miro |

OG in parallel:

- Insurance broker call: confirm receiving-fleet PHV insurance covers cross-network bookings.
- Legal counsel: send DPA template requirements.

**Risk this sprint**: Migration cutover. Eamon must write the first migration as the existing schema baseline; do this on a Neon branch before touching prod.

---

## Sprint 3 · Week of 2026-06-16 — Async routing (start)

Goal: routing moves off the request path.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P0-3a | Pick queue technology | Bobby | Andy | ADR in `docs/architecture/` choosing Inngest vs pg-boss vs Trigger | OG (sign-off on cost / vendor lock-in) |
| P0-3b | Receive → enqueue → ack 200 (just inbound) | Mykola | Bobby | Webhook returns 202 in <100ms; job lands on queue; existing sync code still runs as fallback | Miro |
| P0-7 | Backup restore drill | Eamon | Andy | Neon point-in-time restore tested; procedure in `docs/RUNBOOK.md` | Miro |

OG in parallel:

- Iterate DPA template with counsel.
- iCabbi sandbox tenant confirmed; OG runs through first sandbox booking end-to-end.

**Risk this sprint**: P0-3 is the largest single item in the plan. Bobby's ADR shapes the next 3 sprints. If Bobby surfaces a 50/50 trade-off, OG decides same-day — don't let this drift.

---

## Sprint 4 · Week of 2026-06-23 — Async routing (finish) + secrets rotation

Goal: routing fully off the request path; secret rotation procedure exists.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P0-3c | Worker dequeues + routes + emits status webhook back | Mykola | Bobby | Full async path live behind feature flag; sync fallback still exists | Miro |
| P0-3d | Outbound webhook delivery async with retry | Mykola | Bobby | Failed deliveries land in `webhook_deliveries` with retry budget; existing inspector page surfaces them | Miro |
| P0-8 | Secret rotation runbook + dry-run | Eamon | Andy | `PARTNER_CREDENTIAL_KEY` rotation script tested on Neon branch | Miro |

OG in parallel:

- Pilot fleet conversations continue — aim to have one signed LOI by end of Sprint 5.
- ICO registration confirmed.

**Risk this sprint**: Async routing has hidden edge cases (duplicates, ordering, late acks). Bobby joins the standup daily this week.

---

## Sprint 5 · Week of 2026-06-30 — Acceptance window + DPA

Goal: bookings that aren't accepted re-route automatically; legal scaffolding ready.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P1-E1 | Acceptance window + auto-reroute | Mykola | Andy | 90s ASAP / 5min pre-book window; scheduled job re-routes; new transit status `re_routed` | Miro |
| P1-S1 | DPA template finalised | OG + counsel | OG | Executable DPA in `docs/legal/` | OG |
| P1-S2 | Privacy policy + terms draft | Vicki + counsel | Andy | Drafts ready for legal review | OG |

OG in parallel:

- First pilot LOI signed.
- Pen test scope confirmed with tester.

**Risk this sprint**: P1-E1 affects routing semantics. Bobby reviews the spec before Mykola starts — auto-reroute can easily double-route a booking if not careful.

---

## Sprint 6 · Week of 2026-07-07 — Reliability scoring + self-service onboarding

Goal: routing prefers reliable partners; new partners can self-onboard.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P1-E2 | Reliability scoring in routing | Mykola | Bobby | Nightly job computes per-partner reliability; score factored into routing; below-floor auto-suspends | Miro |
| P1-P1 | Self-service signup flow | Mykola + Derek | Andy | `/signup` page; admin review queue; on-approval magic link to credential setup; Vicki writes welcome email copy | Miro |

OG in parallel:

- Welcome email designed (Derek) + copy (Vicki).
- Pilot partner #1 starts technical conversations.

---

## Sprint 7 · Week of 2026-07-14 — Idempotency + partner dashboard

Goal: every code path is replay-safe; pilot fleet has a usable partner-side dashboard.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P1-E3 | Idempotency hardening | Mykola | Bobby | iCabbi adapter idempotent on external id; webhook handlers dedupe on event id; property test for fee determinism | Miro |
| P1-P2 | Partner-side dashboard polish | Mykola + Derek | Andy | Live receiving jobs view; earnings statement; pause toggle; routing rules view | Miro |
| P1-E4 | iCabbi sandbox nightly integration test | Eamon | Mykola | Cron job runs real round-trip nightly; failures wake on-call | Miro |

OG in parallel:

- Pilot partner #1 sandbox integration testing.
- Pilot LOI #2 in flight.

---

## Sprint 8 · Week of 2026-07-21 — Pen test week

Goal: external security review executes. Engineering quiet week — defensive only.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| External | Pen test executes (Mon–Fri) | External tester | — | Report delivered Friday | OG |
| P1-S3 | PII minimisation audit | Mykola | Andy | All log statements reviewed; retention policy doc | Miro |
| P1-S3.5 | Anonymisation cron job | Mykola | Andy | 90-day cutoff; replace name/phone with hash | Miro |

OG in parallel:

- Status page picked + provisioned (Cachet or statuspage.io).
- Slack channel for pilot fleet operators set up.

**Risk this sprint**: pen test is timeboxed to a calendar week. Findings drop Friday afternoon; do not commit to features for the following sprint until findings are triaged.

---

## Sprint 9 · Week of 2026-07-28 — Pen test remediation + billing start

Goal: every High and Critical pen test finding fixed; billing infrastructure begins.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| External | Triage pen test findings | Bobby + Mykola | Bobby | Every finding ranked + assigned + dated | OG |
| External | Remediate all Critical + High | Mykola | Bobby | Each closed with a commit referencing the finding ID | Miro |
| P1-P3a | Billing data model + line generation | Mykola | Andy | Daily aggregate of completed transits per partner per period | Miro |

OG in parallel:

- VAT registration if not already done.
- Stripe Billing account set up.
- Pilot partner #1 credentials issued; first dry-run booking through production.

---

## Sprint 10 · Week of 2026-08-04 — Billing finish + status page + runbook

Goal: we can invoice; we can communicate during incidents.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P1-P3b | Stripe Billing wired up | Mykola | Andy | Test invoice generated for pilot partner; preview UI for finance | Miro |
| P1-O1 | Status page live | Eamon | Andy | Public page with 4 components; linked from login | Miro |
| P1-O3 | Runbook complete | Eamon + Bobby | Andy | All 7 scenarios in `docs/RUNBOOK.md` with copy-paste commands | Miro |
| P1-O2 | On-call rotation + paging | Eamon | OG | Better Stack or PagerDuty configured; severity defs in runbook | OG |

OG in parallel:

- Welcome partner #1 to soft-launch chat channel.
- Insurance review final confirmation.

---

## Sprint 11 · Week of 2026-08-11 — DR drill + synthetics + go/no-go prep

Goal: every go/no-go gate is green except the final sign-off.

| ID | Item | Owner persona | Spec by | Deliverable | DoD signed by |
| --- | --- | --- | --- | --- | --- |
| P1-O4 | Synthetic monitoring | Eamon | Andy | Hourly test booking through smoke pair; failures page on-call | Miro |
| External | DR drill (full) | Eamon | OG | Restore from backup, route traffic to restored stack, document gaps | OG |
| P1-E5 | Connection pool + index pass | Mykola | Bobby | Indices added; pool sized; EXPLAIN ANALYZE on top 10 queries; results in `docs/performance.md` | Miro |
| Review | Final security review | Bobby | — | All P0 items re-verified post-pen-test | OG |

OG in parallel:

- Sponsor go/no-go meeting scheduled for Sprint 12 Wednesday.

---

## Sprint 12 · Week of 2026-08-18 — Soft launch

Goal: pilot partner #1 receives live traffic at low volume under tight monitoring.

| Day | Activity | Owner | Notes |
| --- | --- | --- | --- |
| Mon | Go/no-go checklist final walk-through | OG + Bobby | 11 items in readiness doc must all be checked |
| Tue | Final pen test sign-off | OG | All Critical/High closed; Medium triaged with dates |
| Wed | Sponsor go/no-go meeting | OG | Decision in writing |
| Thu morning | Enable pilot partner in production | Eamon + Mykola | Volume cap engaged: 20 jobs/hour initially |
| Thu all day | Watch + nothing else | All personas | Standup every 2 hours, not daily, for first 48h |
| Fri | Post-mortem of first 24h | Miro | What broke, what didn't, what we missed |

Success criteria for this sprint:
- 50+ real bookings routed
- <5% no_match
- <1% adapter errors
- 0 P0 incidents
- All status events propagating back to originator within 30s p95

If any of those misses, hold partner #2 onboarding to next sprint.

---

## Sprint 13 onward — Pilot stabilisation

- Onboard pilot partner #2 (Sprint 13).
- Onboard pilot partner #3 (Sprint 14).
- Begin P2 work in parallel: read replica, caching, SOC 2 evidence collection.

This document is updated weekly post-pilot until we hit 5 partners stable, at which point a separate "Scale phase" plan supersedes it.

---

## Standing risks (review every Friday)

| Risk | Mitigation | Owner of mitigation |
| --- | --- | --- |
| P0-3 async routing slips | Buffer in Sprint 4; if still slipping, descope reliability scoring (P1-E2) | Bobby |
| Pen test surfaces a critical finding requiring architectural change | Sprint 9 has all critical/high remediation; Sprint 10 can stretch | Bobby + Mykola |
| Pilot partner pulls out | Three candidates in pipeline at all times; never single-partner dependency | OG |
| OG is sole point of failure on legal / commercial | Document every commitment in `docs/decisions/`; counsel reviews every contract | OG |
| Costs balloon (Sentry, Inngest, Upstash, etc.) | Weekly cost check on Friday review; budget envelope £400/month at pilot scale | Eamon |

---

## Personas — what they actually do this quarter

- **Andy (PO)** writes the spec for every item before Mykola starts. Andy refuses to let Mykola begin without a spec. Every spec ends with acceptance criteria Miro will check.
- **Mykola (Eng)** implements. Doesn't introduce dependencies without Bobby's nod. Asks Andy when the spec is ambiguous, asks Bobby when the spec contradicts existing patterns.
- **Bobby (Tech Lead)** owns ADRs for P0-3 queue choice, reliability scoring algorithm, idempotency model. On call for hard bugs.
- **Miro (QA)** signs every DoD. The Friday review is Miro's hour — anything not signed off rolls. Owns the regression test suite.
- **Derek (Design)** reviews every UI-touching PR. Owns partner-side dashboard polish (Sprint 7) and signup flow visual design (Sprint 6).
- **Eamon (DevOps)** owns every migration, every env var change, every deploy step. Owns runbook authorship. Pages himself if a P0 incident fires.
- **Vicki (Copy)** owns welcome emails, signup microcopy, privacy policy plain-English draft, status page text, every customer-facing word.

---

## Communications cadence

- **Daily standup** (09:30, 5 min): personas + OG.
- **Weekly sponsor update** (Friday 17:00): email from OG. Format: shipped this week / shipping next / blocked / asks.
- **Weekly pilot partner update** (Friday 17:00 from Sprint 7): personalised message per pilot partner. Where their integration stands.
- **Weekly risk review** (Friday sprint review): walk the standing risks table; update mitigations.
- **Monthly board / investor letter** (last Friday of month): 1-pager summarising the month against this plan.

---

## What this plan deliberately doesn't include

- Hiring plan (separate doc, on hold pending Sprint 1 decision)
- Marketing launch (separate doc, kicks in Sprint 10)
- Sales process for partners 4+ (separate doc, kicks in pilot+30 days)
- Pricing experimentation (P2, not in scope for this 13-sprint plan)

---

## How to use this document

- Each sprint section is the contract for that week. If something here isn't getting done, raise it in standup before Wednesday.
- Items move down (later sprint) by mutual agreement at Friday review. They don't move up. Don't compress.
- New work that arrives mid-sprint goes into `docs/inbox.md` for triage at the next Monday planning. Don't insert mid-sprint unless it's a P0 production incident.
- This document is editable. Don't fork it. PRs welcome.

---

*Sprint planning agenda for Monday 2026-06-09 (Sprint 2 kickoff) will be drafted by OG on Friday 2026-06-06.*
