# Async routing

How inbound bookings flow through the system without making the originator wait for a routing decision.

## The problem

Before P0-3, the inbound webhook handler called `routeBooking()` synchronously. The handler couldn't 200 ack until every step had completed — including the recipient adapter's `createBooking` HTTP call, which can take 1–3 seconds when iCabbi's tenant is under load, plus up to 5 waterfall attempts on failure. A slow downstream partner could keep the webhook open for 10+ seconds. Most webhook systems retry on slow ack, so we'd get duplicate events arriving while we were still processing the first one.

## The flow now

```
[ Partner webhook ]
        ↓
POST /api/webhooks/ingest/:partnerId       ← <100ms total
  ├─ HMAC verify
  ├─ rate limit check
  ├─ sent_at freshness check
  ├─ idempotency check
  ├─ adapter.normaliseInboundWebhook        ← shape parsing, no I/O
  ├─ receiveBooking()
  │    └─ insert transit at status='received'
  └─ 200 ack

                                            ← partner is done

   ┌─ Vercel cron (every minute) ───────────────────────┐
   │  OR demo background tick (every 20s in DISABLE_AUTH) │
   │                                                      │
   │  processReceivedTransits()                           │
   │    ├─ select 20 transits at status='received'        │
   │    ├─ claim each via conditional UPDATE              │
   │    │   (received → routing)                           │
   │    ├─ run routeBooking() per transit                  │
   │    │   ├─ rankCandidates (geo + fee + reliability)    │
   │    │   ├─ waterfall up to 5 candidates                │
   │    │   ├─ set acceptDeadline on push                  │
   │    │   └─ persist linkage + outcome                   │
   │    └─ aggregate counts logged                         │
   └──────────────────────────────────────────────────────┘
```

## What lives where

| Component | Path | Purpose |
| --- | --- | --- |
| Receive | `receiveBooking()` in `src/lib/routing.ts` | Fast path: write transit at `received`, kill-switch aware, idempotent on `(originator, external_id)` |
| Drain | `processReceivedTransits()` in `src/lib/routing.ts` | Background processor; claims via conditional UPDATE so concurrent workers don't race |
| Cron route | `/api/cron/process-queue` | Vercel-cron-authenticated GET; calls the drain |
| Cron schedule | `vercel.json` `crons` array | Every minute |
| Local drain | `src/lib/demo.ts` `maybeTickDemoMode` | Calls the drain on the existing 20s tick so demos progress without waiting for cron |
| Auth | `src/middleware.ts` | `/api/cron/` is in PUBLIC_PREFIXES (authenticated via `x-vercel-cron` or `Bearer $CRON_SECRET`) |

## Concurrency safety

Two cron invocations (Vercel + the demo tick on the same instance) could race for the same row. We handle it via a conditional UPDATE:

```sql
UPDATE transits
SET status = 'routing'
WHERE id = $1 AND status = 'received'
RETURNING id
```

Postgres guarantees this is atomic. Whichever transaction commits first wins the row; the other sees an empty `RETURNING` and skips. The drain code increments `outcomes.skipped` so we observe the race rather than crashing.

## Synchronous routing is still available

For callers that need the routing outcome immediately:

- `pnpm fire-jobs` — the synthetic load script (wants per-job stats)
- The test booking form on `/partners/[id]` (admin watching the result)
- The "Retry routing" button on the booking detail page (admin click → immediate feedback)

All three still call `routeBooking()` directly. They bypass the queue. This is by design — the queue is for partner-driven webhook traffic where the partner doesn't care about the outcome of *their* call.

## Failure modes

| Scenario | What happens |
| --- | --- |
| Cron disabled in Vercel | Drain doesn't run. Received transits accumulate. Demo tick still drains on the live URL since `DISABLE_AUTH=true`. Manual fix: hit `/api/cron/process-queue?token=...` with `Authorization: Bearer $CRON_SECRET`. |
| Cron route times out | Vercel limit is 10s for Hobby plan, 60s for Pro. With batch size 20, ~3-5s expected. If we exceed, drop batch size or split. |
| Drain crashes mid-batch | Whatever was already updated stays at `routing` — needs manual `UPDATE transits SET status='received' WHERE status='routing' AND updated_at < now() - interval '5 minutes'` to recover. Worth adding a stuck-state reaper as a follow-up. |
| Partner's webhook arrives twice for the same booking | First call writes the transit. Second call hits idempotency, returns `outcome: "duplicate"` and 200 acks. |
| Kill switch on | `receiveBooking` writes at `paused` instead of `received`. Drain doesn't touch paused rows. `setKillSwitch(false)` then runs `resumePausedTransits()` which re-routes them. |

## Scaling thresholds

Pilot scale: 5 partners × low-hundreds-of-bookings/day = ~50–100 bookings/min peak. Postgres-polling drain at every-minute cron handles this fine.

At ~1000 bookings/min sustained, consider:
1. Shorter cron interval (Vercel supports `* * * * *` which is the floor)
2. Bigger batches (raise the 50 cap in `processReceivedTransits`)
3. **Switch to push-driven queue** — Inngest or Trigger.dev fire on insert rather than polling
4. **Move drain off Vercel functions** entirely (Cloudflare Workers, Render background worker)

The `processReceivedTransits()` signature stays the same; only the trigger changes. Drop-in.

## Required env vars

- `CRON_SECRET` (optional but recommended) — bearer token for manual cron invocation. If unset, only `x-vercel-cron: 1` requests are accepted. Set this in Vercel env vars + commit a copy nowhere.

## Observability

Every cron run logs to Vercel function logs:

```
[process-queue] scanned=12 pushed=10 no_match=1 error=1 skipped=0 (4.2s)
```

When Sentry lands (P0-6), every error inside the drain captures a transaction with `transit_id` and `originator_partner_id` in scope.

## Manual operations

**Force a drain right now** (e.g. during a demo):

```bash
curl -X POST https://the-exchange-z2wp.vercel.app/api/cron/process-queue \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Drain a single transit manually:**

Use the `transit.manual_retry` admin button on `/transits/[id]` — same effect for a single row.

**Pause the drain entirely:**

Toggle the network kill switch. New bookings still arrive (as `paused`); cron still runs but finds no `received` rows.

## Migration from synchronous routing

This was a non-breaking change. Synchronous `routeBooking()` is still exported and used by three callers. Only the inbound webhook handler swapped to `receiveBooking`. No data migration was required — the new `received` status was already in the `transit_status` enum from the original schema.
