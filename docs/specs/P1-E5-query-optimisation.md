# P1-E5 — Query optimisation + index hardening

*Author: Franko · Status: spec → implementation in same PR · Estimate: ~2h*

## Problem

We're feature-complete and live with demo traffic (~470 transits, 100 partners). Real partner traffic lands in Sprint 12. Several hot read paths run sequential scans that will become latency hotspots well before the soft launch:

1. `recheckStaleAcceptances()` scans `transits` every minute (every 20s in demo) filtering on `status='pushed' AND accept_deadline < now()`. Currently leans on the `status` index alone — at 10k+ pushed rows that's a sort-and-discard.
2. `recomputeAllPartnerReliability()` runs every 5 min over a 7-day window of `transits` joined to `transit_events`. The outer filter is `recipient_partner_id IS NOT NULL AND created_at > now() - 7 days` — neither column is indexed for that combination.
3. `/bookings` orders 200 rows by `created_at DESC` after a status filter — no `created_at` index, so Postgres sorts the filtered set every render.
4. `/distribution` daily sparkline runs `date_trunc('day', created_at) GROUP BY day` over 14 days — no `created_at` index.
5. Dashboard auto-suspended banner filters `audit_log.action = 'partner.auto_suspended' AND created_at >= 7d ago` — no `action` index.
6. `/webhooks` loads **every** `webhook_deliveries` row into memory just to compute outcome counts (line 71-73 of `src/app/webhooks/page.tsx`). At 10k+ deliveries that's a page-load hazard.
7. Routing candidate filter scans `partners` by `participation_mode IN (...)` — no index. 100 partners today, would matter at 1k.

None of these is breaking the demo. All of them would surface as P95 latency complaints inside the first month of real traffic.

## Out of scope

- Connection pooling tuning (Neon's pooled URL is fine for pilot scale).
- Switching off postgres-polling drain for a real queue (P0-3 follow-up, separate spec).
- Caching layer (Redis / Vercel KV). Premature — fix the data layer first.
- Read replica strategy. Not needed at pilot scale.
- pg_stat_statements wiring. We'll instrument from Sentry breadcrumbs first; revisit if needed.

## Acceptance criteria

1. **No sequential scans on hot paths.** After this PR, `EXPLAIN ANALYZE` on the five queries below uses an index scan or bitmap heap scan:
   - `recheckStaleAcceptances` SELECT
   - `recomputeAllPartnerReliability` outer SELECT
   - `/bookings` ORDER BY query
   - `/distribution` 14-day sparkline
   - Dashboard auto-suspended count

2. **All new indexes ship via Drizzle migration.** No more out-of-band `CREATE INDEX` on prod. The migration file is committed and runs via the existing `pnpm db:migrate` pipeline (P0-2).

3. **`scripts/sync-prod-schema.sql` adds the same indexes idempotently** using `CREATE INDEX IF NOT EXISTS` (we keep this file as the recovery path until the migration baseline is fully reset).

4. **N+1 fix on `/webhooks`** — outcome counts move from "load all rows + reduce in JS" to a single `SELECT outcome, COUNT(*) GROUP BY outcome` query. Page render time becomes O(distinct outcomes), not O(deliveries).

5. **No correctness regressions.** Vitest suite green. Typecheck green.

## Index plan

| Index | Table (cols) | Predicate | Why |
|---|---|---|---|
| `transits_accept_deadline_idx` | `transits (accept_deadline)` | `WHERE status='pushed' AND accept_deadline IS NOT NULL` | Hot scan every 20s in demo / every min in prod. Partial keeps it tiny — only pushed-with-deadline rows. |
| `transits_created_at_idx` | `transits (created_at DESC)` | — | Supports `/bookings` order, dashboard recent, distribution 14-day sparkline. |
| `transits_originator_idx` | `transits (originator_partner_id)` | — | Fleet-scoped views on dashboard + partner detail. |
| `transits_recipient_created_idx` | `transits (recipient_partner_id, created_at DESC)` | — | Reliability recompute outer filter + "active bookings to me" feed on partner detail. Composite > two singles for this access pattern. |
| `transits_reconciled_flagged_idx` | `transits (id)` | `WHERE reconciled_flagged = true` | Dashboard banner check. Partial keeps it 4–6 rows even at scale. |
| `audit_log_action_idx` | `audit_log (action, created_at DESC)` | — | Auto-suspended count + future "actions of type X in last N days" queries. |
| `partners_participation_mode_idx` | `partners (participation_mode)` | — | Routing candidate filter. |
| `transit_events_transit_created_idx` | `transit_events (transit_id, created_at DESC)` | — | Bookings-page driver detail batched lookup. Composite supersedes the two singles. |
| `webhook_deliveries_received_at_idx` | `webhook_deliveries (received_at DESC)` | — | Inspector page sort. |

Nine new indexes. None of them are write-amp hazards at our scale (the unique idempotency index on `transits` already exists and is the heaviest one).

Indexes intentionally **not** added:

- `transits.status` already exists.
- `transits.reconciled_at IS NULL` — the `status='completed'` filter in `reconcileCompletedTransits` already narrows enough that the existing status index suffices.
- `partners.status` and `partners.kind` already exist.
- `audit_log.created_at` and `audit_log.category` already exist.

## N+1 / over-fetch fixes

1. **`src/app/webhooks/page.tsx` outcome counts.** Replace the "load all rows then `for` loop" with a `GROUP BY outcome` query. Keep the existing detail-rows query as-is — it's already paginated to 100.

## Files likely touched

- `src/db/schema.ts` — add 9 index declarations.
- `drizzle/0001_*.sql` (auto-generated) — new migration with `CREATE INDEX` statements.
- `scripts/sync-prod-schema.sql` — append idempotent `CREATE INDEX IF NOT EXISTS` clauses (keep parity with the migration for prod safety).
- `src/app/webhooks/page.tsx` — replace `statsRows` reducer with a `GROUP BY` query.

## Rollout plan

1. Add index declarations to schema.
2. Run `pnpm db:generate` to produce the migration. Inspect — it should be index-only DDL.
3. Apply locally via `pnpm db:migrate`. Smoke-check `EXPLAIN ANALYZE` on at least the reroute scan and bookings query (manual; not automated yet).
4. Append idempotent statements to `scripts/sync-prod-schema.sql` (recovery path).
5. Ship to prod via Vercel deploy. Migration runs as part of `buildCommand: "pnpm db:migrate && pnpm build"`.
6. **No `CREATE INDEX CONCURRENTLY`** in the Drizzle migration because Drizzle wraps migrations in a transaction. At ~470 rows the table-level lock is sub-millisecond. If we hit a table that's grown by >100k rows before this ships, we drop the migration and run the concurrent variant out-of-band via `sync-prod-schema.sql` — but at current volumes the simple migration is fine.

## Measurement

After deploy:
- Inspect the structured-log entries from `[reliability]` and `[reconciliation]` ticks — they include scan counts. Watch for divergence from baseline.
- Synthetic monitor (P1-O4) gives us an hourly latency signal on the routing path. Watch elapsed_ms — should not regress.
- Sentry breadcrumbs will surface any slow query >1s once the Sentry hook in P0-6 is wired with a real DSN.

## Risks / open questions

- **Index bloat over time** — Postgres will need periodic `REINDEX`. We document this in `RUNBOOK.md` as a quarterly task; not a P0 ops concern at pilot scale.
- **Plan flips on small tables** — partial indexes can lead the planner astray when a table is tiny. At ~470 transits Postgres will still seqscan and that's correct. Once volume crosses ~10k the indexes will win consistently. We accept that.
- **One spec, two skills.** Normally Franko writes the spec, Mykola implements. This PR is small enough that I'm shipping both as the same author. Miro signs off on the DoD as usual.
