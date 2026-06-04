# Observability

How we see what's happening in production. Right now: structured logs in Vercel. After Sentry activation: errors with full stack + tags in Sentry too.

## Current state — structured logs

Every async path captures errors via `captureError(err, context)` from `@/lib/observability`. The context object accepts:

- `transit_id` — the booking id when relevant
- `partner_id` — the partner id when relevant
- `request_id` — request lifecycle id when available
- any other string-keyed tags

Until Sentry is activated, `captureError` calls the default sink which logs a structured error via `@/lib/logger`. In production this emits one-line JSON:

```json
{"ts":"2026-05-30T10:32:08.532Z","level":"error","msg":"adapter blew up","area":"process_queue","transit_id":"...","err":{"message":"...","stack":"..."}}
```

Vercel's log search at https://vercel.com/cmo-4112f7b2/the-exchange-z2wp/logs indexes this. Filter by:
- `level:error` — only errors
- `area:process_queue` — errors from the routing queue drain
- `transit_id:abc123` — every event for one booking

`@/lib/logger` also exports `log.info`, `log.warn`, `log.debug`, `log.error` for non-error logging. Same structure.

## What gets captured today

| Area tag | Source | When |
| --- | --- | --- |
| `process_queue` | `processReceivedTransits()` | A transit failed mid-drain. The other transits in the batch still run. |
| `kill_switch_off_resume` | `setKillSwitch(false)` | The dynamic-import + call to resumePausedTransits failed |
| `resume_paused` | `resumePausedTransits()` | A single paused transit failed to resume; others continue. |
| `reroute` | `recheckStaleAcceptances()` | Single-transit reroute crashed |
| `reconciliation` | `reconcileCompletedTransits()` | Single-transit reconciliation crashed |
| `reconciliation_run` | `maybeReconcileCompletedTransits()` | The whole reconciliation tick crashed |
| `reliability_recompute` | `maybeRecomputeReliability()` | The whole reliability tick crashed |

Demo-tick fire-and-forget warnings (`[demo] tick failed`) are intentionally NOT routed through `captureError` — they're best-effort, not actionable.

## Activating Sentry

Three steps:

### 1. Install the package

```bash
pnpm add @sentry/nextjs
```

### 2. Set the env vars

In https://vercel.com/cmo-4112f7b2/the-exchange-z2wp/settings/environment-variables:

| Variable | Scope | Sensitive? | Notes |
| --- | --- | --- | --- |
| `SENTRY_DSN` | Production | No | Server-side capture |
| `NEXT_PUBLIC_SENTRY_DSN` | Production | No | Optional. Client-side capture (browser errors). Same DSN value. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Production | Yes (auth token) | Only needed for source-map upload at build time. Skip until you want symbolicated stack traces. |

Don't mark the DSN as Sensitive — it's a public identifier (the secret is the auth token).

### 3. Uncomment the init block

Edit `src/instrumentation.ts` and uncomment the `Sentry.init()` block inside `register()`. The pattern is documented in the file.

After deploy, the next error captured via `captureError` will appear in your Sentry dashboard with all the context fields as tags. Filter / alert in Sentry's UI.

## Alert routing recommendations

Once Sentry is on, set these in the Sentry project:

**P0 alerts (page on-call immediately):**
- Any error with tag `area:process_queue` AND frequency > 5 in 5 min — queue drain is failing systemically
- Any error with tag `area:reliability_recompute` AND frequency > 3 in 1 hour — metrics computation broken (auto-suspend can't fire)

**P1 alerts (Slack #exchange-errors):**
- Any error with tag `area:reroute` — single-transit rerouting failed
- Any error with tag `area:reconciliation` — single-transit reconciliation failed
- Spike: error rate per minute > 3x rolling 7-day average

**Filter out the noise:**

The `beforeSend` hook in `instrumentation.ts` already filters HMAC signature mismatches and stale-event rejections. These happen during partner onboarding (clock skew, misconfigured webhook secrets) and aren't actionable until a partner reports the failure.

## Log structure conventions

When adding new captures, include these tag fields when relevant:

```ts
captureError(err, {
  area: "your_area_name",     // required — coarse-grained categorisation
  transit_id: t.id,            // when a transit is involved
  partner_id: p.id,            // when a single partner is involved
  request_id: req.id,          // when in a request lifecycle
  // anything else as needed
});
```

The `area` tag is the primary filter axis. Naming convention: `module_name` or `module_name_action` (e.g. `process_queue`, `kill_switch_off_resume`).

## What's NOT instrumented

- **Client-side errors** — `NEXT_PUBLIC_SENTRY_DSN` would handle this but we haven't wired the client init yet. Browser errors today only surface in user reports.
- **Performance traces** — `tracesSampleRate: 0.1` in the init block samples 10% of transactions. Tune up if you need to debug latency; tune down if it costs too much.
- **Distributed traces** — when a webhook arrives, fires async drain, sends outbound event, calls partner adapter — that's 4 hops in our system + N more in the partner's system. Stitching them together needs trace propagation we haven't added. Worth doing when we onboard non-iCabbi adapters.
- **Profiling** — Sentry profiling captures stack samples. Not worth it at pilot scale.

## Diagnostic patterns

**"Why did this booking fail?"**
1. Open `/transits/[id]` in the dashboard
2. Routing decision card shows what the engine tried
3. If you need more: Vercel logs search by `transit_id:<id>` shows every log line for that booking
4. After Sentry activation: search Sentry by the same tag

**"Why is the queue backing up?"**
1. `/distribution` shows the In-flight count
2. Vercel cron logs at https://vercel.com/cmo-4112f7b2/the-exchange-z2wp/logs filtered by path=/api/cron/process-queue
3. Each cron run logs the outcome counts as JSON — grep for `error` field > 0

**"Why is partner X suddenly suspended?"**
1. `/audit` page filtered by category=admin shows the auto-suspend event
2. Partner detail page shows the `statusReason` chip with the rate + sample size
3. Vercel logs filtered by `partner_id:<id>` shows the lifecycle

## Cost expectations

At pilot scale (~500 bookings/day, ~50 errors/month):

- Sentry free tier: 5k errors/month, 10k performance events. Plenty.
- Vercel logs: included in deployment plan.
- Total observability cost at pilot: £0.

At 100k bookings/month, you'd likely hit Sentry's Team tier (~$26/month). Still cheaper than building this yourself.
