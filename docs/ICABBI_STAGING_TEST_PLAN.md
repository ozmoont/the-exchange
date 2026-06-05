# iCabbi Staging — End-to-End Test Plan

*Real credentials, real iCabbi staging infra. First confirmed round-trip.*

The test flow:

```
FreeNow Dummy (originator, no real API)
        │
        │  pnpm smoke:icabbi-staging synthesises a booking from here
        ▼
The Exchange (routing engine, candidate selection, fee snapshot)
        │
        │  picks iCabbi Staging COID 1102 or 2102 (bilaterally allowed,
        │  closest geo, fee + reliability ranked)
        ▼
iCabbi Staging API (https://1stagingapi.icabbi.com/1staging)
        │
        │  POST /bookings/add → returns body.booking.perma_id + trip_id
        │
        ▼
Driver app simulator on iCabbi side
        │
        │  drivers 147 / 1889 / 5200 (1102) or 999 (2102)
        │  accept, en-route, on-board, completed
        ▼
Webhook events flow back to /api/webhooks/ingest/<our partner id>
(this leg blocked on iCabbi item #5 — confirming how they push to us)
```

---

## Step 1 — Get the build green

Before any of this works, the Vercel deploys need to succeed. Commit and push the build-fix changes from `HANDOVER.md` first. Verify the green deploy on Vercel before proceeding.

---

## Step 2 — Drop the staging credentials into your env

The iCabbi App-Key + Secret-Key for COID 1102 and COID 2102 are in those secureshare URLs. They are **live credentials**. Treat them like prod secrets.

**Local development:** add to `.env.local` (gitignored). Note these are only used by the migrate/seed scripts to confirm DB connection — the App-Key/Secret-Key themselves go into the encrypted `partners.credentials` field via the integration UI, not into env vars.

**Production (Vercel):** no action needed for the staging keys at the Vercel-env-var level. The encrypted-at-rest pattern means they live in the DB, not the deploy.

The one URL you DO want to know cold:

```
ICABBI_STAGING_API_URL = https://1stagingapi.icabbi.com/1staging
```

You'll paste this into the "API URL" field on `/partners/<id>/integration` for both staging tenants.

---

## Step 3 — Seed the three test partners

```bash
cd ~/Desktop/ClaudeCode/the-exchange
pnpm seed:icabbi-staging
```

This creates:

- **FreeNow Dummy (test originator)** — `external_aggregator`, London centroid, no real FreeNow API key. The source of synthesised bookings.
- **iCabbi Staging COID 1102** — `icabbi_fleet`, London centroid, drivers 147 / 1889 / 5200.
- **iCabbi Staging COID 2102** — `icabbi_fleet`, Manchester centroid, driver 999.

Plus bilateral allow rules between all three (so routing can waterfall) and default fee config (20p send, 40p receive).

Idempotent — safe to re-run. Existing rows get updated in place; rules upserted by primary key.

---

## Step 4 — Paste credentials via the integration UI

Visit `/partners` and find the two iCabbi staging entries.

**For each one (COID 1102 and COID 2102):**

1. Click into the partner → Integration tab
2. Read the "What happens when you click Connect" preview block
3. Paste:
   - **App-Key** — from the relevant secureshare link
   - **Secret-Key** — from the same secureshare link
   - **API URL** — `https://1stagingapi.icabbi.com/1staging`
4. Click **Connect**
5. Copy the webhook signing secret shown in the green banner — it's shown **once**. Save it (1Password, Bitwarden, anywhere safe but not in a commit).

Watch the result banner. Three outcomes:

- **"Webhook subscription auto-registered with iCabbi (subscription id ...)"** — perfect, both sides are wired.
- **"Credentials saved, but webhook auto-registration failed"** — credentials are saved + encrypted. iCabbi-side webhook subscription needs manual registration. This will block the inbound flow but **not** the outbound smoke. Continue to step 5; chase iCabbi item #4 (webhook subscription endpoint confirmation) separately.
- **"App-Key and Secret-Key are both required to connect"** — you missed a field. Re-enter.

After connecting, the partner's `adapterKey` flips from `mock_icabbi` to `icabbi`. From now on every routing call to this partner hits real iCabbi staging infra.

Repeat for the second tenant.

---

## Step 5 — Run the smoke

```bash
pnpm smoke:icabbi-staging
```

Expected output (success):

```
[smoke] iCabbi staging end-to-end

[smoke] iCabbi Staging COID 1102: configured (apiBaseUrl=https://1stagingapi.icabbi.com/1staging)
[smoke] iCabbi Staging COID 2102: configured (apiBaseUrl=https://1stagingapi.icabbi.com/1staging)

[smoke] firing test booking from FreeNow Dummy → routing engine

[smoke] routing outcome: pushed
[smoke] transit id     : 11f02ffa-7d88-73c4-9d0c-0242ac120004
[smoke] transit status : pushed
[smoke] recipient      : iCabbi Staging COID 1102
[smoke] iCabbi perma_id: 123
[smoke] fee snapshot   : send=20p receive=40p
[smoke] last event     : pushed

[smoke] ✓ PASS — real iCabbi staging accepted the booking
[smoke]   inspect the transit on the dashboard:
[smoke]     /transits/11f02ffa-7d88-73c4-9d0c-0242ac120004
[smoke]   then drive the lifecycle from the iCabbi side using
[smoke]   the driver app simulator (drivers 147/1889/5200 on 1102,
[smoke]   or driver 999 on 2102).
```

Failure paths and what they mean:

| Exit code | Meaning | Where to look |
|---|---|---|
| 1 | A required partner row missing OR credentials not configured | Re-run `pnpm seed:icabbi-staging`, paste keys via UI |
| 2 | `no_match` — routing found no eligible candidate | Check bilateral allow rules + that iCabbi partners are `active` |
| 3 | `paused` — kill switch is engaged | Disengage on the dashboard, re-run |
| 4 | Routing returned something other than `pushed` / no recipient external id | Open `/transits/<id>` to see the iCabbi error message in the routing trace |
| 99 | Uncaught exception | The error stack will tell you — usually a network / cert issue against iCabbi staging |

---

## Step 6 — Drive the lifecycle from the iCabbi side

Once the smoke passes:

1. Open the transit detail page on our side: `/transits/<id>` (URL is in the smoke output).
2. Open the iCabbi driver app simulator on their side. Log in as one of the test drivers (147, 1889, 5200 for 1102; 999 for 2102).
3. The booking should appear as a new job. Accept it. The accept-window countdown on our side should clear when the webhook arrives (assuming iCabbi item #4 is sorted).
4. Progress: en-route → on-board → completed.
5. After completion, the reconciliation cron will pick it up within an hour. Watch for the reconciliation panel on the booking detail.

**If webhook auto-registration failed in step 4**, this lifecycle progression won't show up on our side automatically. You'd need to either:
- Manually register the webhook on iCabbi's side using the URL + signing secret from the integration page
- Or poll `pnpm tsx -e "import('./src/lib/routing.ts').then(...)"` (rough manual call) — but this is bridging a real product gap, not a workflow.

---

## Step 7 — Document what you learned

After the first successful round-trip:

1. Capture one real `TripStatus`, `DriverDetails`, `FinalFareReleased`, and `DriverPositionChanged` payload from `/webhooks` (the inspector page). These are iCabbi item #3, currently blocked.
2. Confirm the HMAC signing header name iCabbi actually used. iCabbi item #4.
3. If anything in the response shape differs from the documented sample in iCabbi dependencies #2, update `src/adapters/icabbi.ts` accordingly.

Each of these closes an outstanding iCabbi dependency. Update `docs/ICABBI_DEPENDENCIES.md` (or this doc) as you learn.

---

## What's NOT covered by this test plan

- **Inbound network-marked bookings.** iCabbi item #5. The "how do bookings flagged for the network reach us" question is still open. Our smoke only exercises the outbound direction (we initiate, iCabbi receives). The inbound direction (iCabbi tenant marks a job for the network, it flows to us, we route it) needs item #5 answered.
- **Rate limits + idempotency contract.** iCabbi items #7 and #8. Won't matter for the smoke (one booking). Will matter for production volume.
- **The aggregator credential model.** Sprint 6 work. The per-tenant keys we have today work for the pilot; aggregator-level credentials would replace this UI flow but aren't blocking now.

---

## Rollback

If something goes badly wrong (corrupted state, accidental real booking on a real fleet):

1. On the dashboard, click **Disconnect** on each iCabbi partner. Adapter flips back to mock, credentials are wiped from our DB, iCabbi-side webhook subscription is deleted via `DELETE /v2/webhooks/{id}`.
2. Delete the three seed partners from `/partners` if you want a clean slate. The `pnpm seed:icabbi-staging` script is safe to re-run after.
3. Re-paste credentials when ready to retry.

No data loss outside the test partners. Other partners + their data untouched.

— Franko
