# Runbook

Operational guide for on-call. Optimised for 2am incident clarity: each scenario starts with the symptom, ends with copy-pasteable commands.

If you're new on-call, read the [Common scenarios](#common-scenarios) section first. The [Backup restore](#backup-restore-p0-7) and [Secrets rotation](#secrets-rotation-p0-8) sections are reference material for planned operations.

---

## Quick reference

| Surface | URL / location |
| --- | --- |
| Live app | https://the-exchange-z2wp.vercel.app |
| Vercel project | https://vercel.com/cmo-4112f7b2/the-exchange-z2wp |
| Vercel logs | https://vercel.com/cmo-4112f7b2/the-exchange-z2wp/logs |
| Vercel env vars | …/settings/environment-variables |
| Vercel crons | …/settings/cron-jobs |
| Neon project | https://console.neon.tech (project: the-exchange) |
| Sentry | https://sentry.io (once activated — see [OBSERVABILITY.md](OBSERVABILITY.md)) |
| Github repo | https://github.com/ozmoont/the-exchange |

| Local command shortcuts | What |
| --- | --- |
| `pnpm db:migrate` | Apply pending schema migrations |
| `pnpm db:generate` | Create a new migration from schema diff |
| `pnpm run-sql <file>` | Run arbitrary SQL via Node (when psql isn't installed) |
| `pnpm spawn-fleets --count N --wipe` | Recreate demo fleets |
| `pnpm fire-jobs --count N` | Inject synthetic bookings |
| `pnpm backfill-reliability` | Populate metrics on existing transits |

---

## Common scenarios

### "A partner says they're not receiving jobs"

**Diagnosis:**
1. Open `/partners/[id]` for the complaining fleet. Check:
   - `Status`: must be `active`. If `suspended` / `warning`, check `statusReason` chip — auto-suspend may have fired (`acceptance_rate_0.37_over_67_pushed_7d`).
   - `Mode`: must include `receive`. `send_only` or `inactive` blocks routing.
2. Open `/rules` matrix. Confirm the originator → recipient pair has a **mutual** allow (both sides need to allow).
3. Open `/distribution`. Is the partner appearing in the "Winning fleets" table at all? If they're winning some but not others, it's a routing-score issue (geo distance, fee, reliability penalty). If zero wins, look at eligibility.

**Common root causes:**
- Suspended by auto-suspend → review acceptance rate, manually reactivate via `/partners/[id]/edit` after addressing the underlying issue
- Not in service radius → `centroid_lat/lng/service_radius_km` need updating
- Vehicle type mismatch — partner has `["standard"]` but bookings request `"exec"`
- Booking type mismatch — partner is `prebook` only, bookings are ASAP

**Restoration after fix:** routing scores update on next 5-min reliability recompute. Or force it:

```bash
curl -X POST "https://the-exchange-z2wp.vercel.app/api/cron/process-queue" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

### "A partner says their webhooks are 401-ing"

**Diagnosis:**
1. `/webhooks` page filtered by `source:ingest:<partnerId>` + `outcome:signature_invalid` — shows the rejected deliveries with their reason in `payload.reason`.
2. Two failure modes:
   - **`missing_sent_at`** — partner's webhook envelope doesn't include `sent_at`. They're not sending the Karhoo-style format. Check their dispatch config.
   - **`stale_sent_at`** — their clock is wrong (or they're truly replaying old events). Compare their `sent_at` to ours in the logs.
3. If neither — it's a HMAC mismatch. Their `webhookSecret` is wrong.

**Fix HMAC mismatch:**

```sql
-- Confirm the partner's current webhookSecret hash (the value is encrypted)
SELECT id, name, credentials::text FROM partners WHERE id = '<partner-id>';
```

To rotate the partner's webhook secret:
1. Visit `/partners/[id]/integration` as super_admin
2. Click "Regenerate webhook secret"
3. Tell the partner the new value through a secure channel (Signal, password manager share)
4. They update their dispatch system

---

### "Routing is slow"

**Diagnosis:**
1. Vercel logs at `/logs` filtered by `path:/api/cron/process-queue` — each run logs `elapsedMs`. Should be <5s for a batch of 20.
2. `/distribution` → `In flight` stat — if growing unboundedly, queue isn't draining fast enough.
3. Look for `area:process_queue` errors in the logs — individual transit failures keep retrying.

**Common causes:**
- Neon cold start — first query after suspension is ~2s. Subsequent fast. Not a real problem.
- A specific recipient adapter is timing out the waterfall — check `transit.routingTrace.waterfallAttempts` for a pattern.
- Cron disabled — check Vercel cron dashboard. Re-enable if off.

**Brute-force drain:**

```bash
# Run drain manually
curl -X POST "https://the-exchange-z2wp.vercel.app/api/cron/process-queue" \
  -H "Authorization: Bearer $CRON_SECRET"
# Repeat 5-10 times to flush a backlog
```

---

### "Engage the kill switch"

When to engage: a misbehaving partner is causing mass-routing errors, or you suspect a security event and want to stop new flow immediately.

**Engage:**
1. Sign in to https://the-exchange-z2wp.vercel.app/
2. On the dashboard, "Network kill switch" section → red **Engage kill switch** button
3. New bookings now land at `paused`. In-flight bookings keep receiving status updates.

**Disengage:**
1. Same button (now reads "Disengage")
2. `resumePausedTransits()` fires automatically — every booking that arrived during the engaged window gets replayed through routing
3. Dashboard banner shows the outcome counts

Engaging the kill switch is logged in `audit_log` with the actor + reason. Disengaging too.

---

### "How do I manually re-route a stuck booking?"

Two paths:

**A. Admin retry button** (terminal failures only — `no_match`, `failed`, `error_*`, `cancelled`):
1. Open `/transits/[id]` as super_admin
2. "Retry routing" card has a single button
3. Resets the transit + re-runs `routeBooking()` with original payload
4. Audit-logged as `transit.manual_retry`

**B. Stuck at `pushed` past the accept window** — auto-reroute should be handling this. If it's not:

```bash
# Check the accept deadline + reroute count
pnpm run-sql /dev/stdin <<EOF
SELECT id, status, accept_deadline, reroute_count, updated_at FROM transits WHERE id = '<transit-id>';
EOF

# If accept_deadline is in the past but status is still 'pushed', the reroute
# job isn't picking it up. Force it:
curl -X POST "https://the-exchange-z2wp.vercel.app/api/cron/process-queue" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

### "A scheduled task (cron) didn't run"

Vercel cron jobs page: https://vercel.com/cmo-4112f7b2/the-exchange-z2wp/settings/cron-jobs

What runs:
- `/api/cron/process-queue` — every minute — drains received transits

If you see "Last execution failed":
1. Click into the execution — shows the response body
2. 401 → `CRON_SECRET` mismatch or missing. Re-check env vars.
3. 500 → app crashed; check the function log at the same timestamp
4. Cron paused in Vercel UI — toggle on

To run a one-off manual drain:
```bash
curl -X POST "https://the-exchange-z2wp.vercel.app/api/cron/process-queue" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

### "An incident is happening, where do I look first?"

1. **Vercel logs** (last 1 hour, filter `level:error`) — anything noisy?
2. **Sentry** (once activated) — alert that fired?
3. **`/distribution`** — is the In-flight count climbing? Errors stat card?
4. **Kill switch** — engage if customer impact is widening
5. **Status page** (post-launch) — update the public component to Investigating

Then communicate:
- Slack #exchange-status (if it exists)
- Email pilot partners if any are affected (you have their `applicantEmail` in the partner detail page)

After resolution:
- Disengage kill switch
- Publish post-incident note via status page
- Schedule a postmortem (template in `.github/PULL_REQUEST_TEMPLATE.md`)

---

## Backup & restore (P0-7)

Neon provides automated point-in-time recovery on every project. Default retention is 7 days on the free tier, longer on paid plans.

### The drill we run monthly

Goal: prove we can recover from yesterday's state into a working app within 10 minutes. **Do this before every pilot partner onboards.**

```
RTO target: 15 minutes (time-to-recover)
RPO target: 1 hour (max data loss accepted)
```

#### Procedure

1. **Pick a recovery point.** Pick a timestamp from "yesterday at the same time of day" (so we test against realistic distance). In Neon UI: Backups → choose a point-in-time, click "Create branch".

2. **Create a recovery branch.** Neon creates a logical branch of the DB at that timestamp. Cost: free, doesn't impact prod. Name it `recovery-drill-YYYYMMDD`.

3. **Get the branch connection string.** Neon shows it in the branch detail page. It looks like:
   ```
   postgresql://neondb_owner:***@ep-recovery-drill-XXX.eu-central-1.aws.neon.tech/neondb
   ```

4. **Point a preview deploy at it.** In Vercel, create a preview deployment of the current main branch with `DATABASE_URL` overridden to the recovery branch. Two ways:
   - Vercel CLI: `vercel deploy --env DATABASE_URL='<recovery-url>'`
   - Preview environment in Vercel dashboard with the override env var

5. **Validate the recovered state.** Visit the preview URL. Check:
   - ✓ Login works
   - ✓ Partners list populated
   - ✓ `/bookings` shows recent transits
   - ✓ `/distribution` map populates
   - ✓ Audit log has events from yesterday but not from after the recovery point

6. **Record the drill outcome.** Add a row to a "Backup drills" log (CSV or Notion table):
   - Date of drill
   - Recovery point chosen
   - Time-to-recover (clock from step 1 to step 5)
   - Issues encountered
   - Sign-off (who validated)

7. **Tear down the recovery branch** when done — Neon UI → Delete branch. (Branches cost compute time if left running.)

### Real-incident restore (not a drill)

Same procedure but instead of creating a preview deploy, **swap the prod DATABASE_URL to the recovery branch**. Steps:

1. Engage kill switch immediately (we don't want new bookings landing in a soon-to-be-replaced DB)
2. Create recovery branch in Neon at the desired point-in-time
3. Update Vercel env var: `DATABASE_URL` → recovery branch URL (Production scope)
4. Trigger a redeploy (Deployments → latest → Redeploy)
5. Validate as in step 5 above
6. Disengage kill switch — `resumePausedTransits()` replays anything that landed at `paused` during the swap
7. Communicate restored status to pilot partners

### Recovery point objectives

| Lost data scenario | Where to recover to |
| --- | --- |
| Database corruption (rare on Neon) | Last known-good point-in-time, usually <1h ago |
| Bad migration applied | Just before the migration ran (Neon timestamp resolution: 1 second) |
| Mass data delete by mistake | Just before the delete (use `audit_log` to find the exact second) |
| Partner-specific data issue | DO NOT do a full restore. Manual surgery — see "Single-row recovery" below |

### Single-row recovery (don't restore the whole DB)

If one partner accidentally deleted some rules, you don't need a full restore.

1. Create a recovery branch as above (read-only OK)
2. Connect to the recovery branch via `pnpm run-sql` with `DATABASE_URL=<recovery>`
3. SELECT the rows you need to recover, COPY their values
4. Re-INSERT them on prod via the regular `DATABASE_URL`

Don't try to dump+restore — easier to hand-copy the few rows you need.

---

## Secrets rotation (P0-8)

We rotate secrets on these triggers:
- **Scheduled** — every 90 days for all secrets (calendar reminder)
- **Departure** — anyone who had access leaves
- **Suspected exposure** — secret appeared in a screenshot, email, log
- **Suspected partner compromise** — only the partner-specific keys

### Inventory of secrets

| Secret | Lives | Used for | Rotation difficulty |
| --- | --- | --- | --- |
| `AUTH_SECRET` | Vercel env vars | HMAC sign session cookies | Easy — invalidates all sessions |
| `PARTNER_CREDENTIAL_KEY` | Vercel env vars | AES-256-GCM key for encrypted `partners.credentials` | **Hard** — must re-encrypt every partner's stored creds |
| `CRON_SECRET` | Vercel env vars | Authorize manual cron invocation | Easy — doesn't impact app users |
| `RESEND_API_KEY` | Vercel env vars | Send magic-link emails | Easy — generate new in Resend dashboard |
| `DATABASE_URL` | Vercel env vars | Postgres connection | Medium — rotate via Neon UI (resets password) |
| Per-partner `webhookSecret` | Encrypted in `partners.credentials` | Sign inbound webhooks | Medium — coordinate with the partner |
| Per-partner `appKey`/`secretKey` | Encrypted in `partners.credentials` | Outbound to partner's iCabbi | Medium — coordinate with partner to issue new |

### Rotating `AUTH_SECRET`

```bash
# Generate a new 32-byte base64 secret
openssl rand -base64 32
# Copy the output
```

1. Vercel env vars → edit `AUTH_SECRET` → paste new value → save
2. Redeploy (any small change, or hit "Redeploy" on the latest deployment)
3. All active sessions now invalid — users will be redirected to /login on next request and need to re-authenticate
4. Old secret: discarded; no further action needed

Communicate: tell active users a re-login is required ("We rotated session keys for security; please sign in again").

### Rotating `PARTNER_CREDENTIAL_KEY` (the hard one)

This is the AES-256-GCM key. Every `partners.credentials` row is encrypted with it. Rotating naively breaks decryption for every partner.

**The procedure:**

1. **Pause routing.** Engage kill switch — new bookings won't try to decrypt creds.

2. **Decrypt-then-reencrypt rows.** Script:

```bash
# Pull the existing key
OLD_KEY=$(vercel env pull .env.tmp --environment=production --yes && grep '^PARTNER_CREDENTIAL_KEY' .env.tmp | sed 's/.*=//')

# Generate the new key
NEW_KEY=$(openssl rand -base64 32)
echo "NEW_KEY=$NEW_KEY (SAVE THIS NOW)"

# Re-encrypt every partner.credentials row with the new key:
PARTNER_CREDENTIAL_KEY_OLD=$OLD_KEY \
PARTNER_CREDENTIAL_KEY_NEW=$NEW_KEY \
pnpm tsx src/scripts/rotate-partner-credential-key.ts
#       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
# (Script not yet written — create when this rotation is first needed.
#  Pattern: SELECT credentials, decrypt with OLD, encrypt with NEW, UPDATE.)
```

3. **Update env var in Vercel:** `PARTNER_CREDENTIAL_KEY` = the new value.

4. **Redeploy.** Subsequent decryption uses the new key.

5. **Disengage kill switch.** Validate by visiting `/partners/[id]/integration` and confirming the App-Key field shows the partner's actual key, not garbage.

6. **Discard old key.** Once validated, the old key is dead and useless.

Don't rotate this casually. It's a multi-step procedure that risks bricking the partner integration if step 2 fails. **Test on a Neon recovery branch first** if you've never done it.

### Rotating `CRON_SECRET`

```bash
openssl rand -hex 32
```

1. Vercel env vars → edit `CRON_SECRET` → paste → save → redeploy
2. Vercel-cron-triggered calls keep working (they use the `x-vercel-cron` header, not the bearer)
3. Anyone who had the old token can no longer manually trigger /api/cron routes

### Rotating `RESEND_API_KEY`

1. Resend dashboard → API Keys → Create new
2. Paste in Vercel env vars `RESEND_API_KEY` → save → redeploy
3. Resend dashboard → revoke old key

### Rotating `DATABASE_URL` (= Postgres password)

In Neon UI → Roles → `neondb_owner` → "Reset password". Neon issues a new connection string.

1. Update Vercel env var `DATABASE_URL` with the new connection string
2. Redeploy
3. Confirm app boots — first cold-start query establishes the new connection

There will be a few seconds of failed queries between (1) and (2) finishing. For a clean swap, engage kill switch first.

### Rotating per-partner secrets

**Webhook secret** — the partner needs to update their dispatch:

1. As super_admin, visit `/partners/[id]/integration`
2. Click "Regenerate webhook secret"
3. Copy the new value
4. Send to partner via secure channel (Signal, password manager share)
5. Partner updates their dispatch's outgoing webhook config
6. Inbound webhooks during the gap fail signature verification (visible at `/webhooks?outcome=signature_invalid`) — partner will retry, will succeed once their side is updated

**iCabbi App-Key / Secret-Key** — the partner gets new ones from iCabbi:

1. Partner asks iCabbi to issue new credentials
2. Partner sends them to you securely
3. As super_admin, `/partners/[id]/integration` → paste new App-Key and Secret-Key
4. We auto-re-register our webhook subscription with the new credentials
5. Old credentials revoked on the partner's iCabbi side

### Secrets that DON'T exist (but might in future)

- `SENTRY_DSN` — not Sensitive when added. Public identifier.
- `SENTRY_AUTH_TOKEN` — Sensitive when source-map upload is enabled.
- `INNGEST_*` — if we move off the Postgres queue.
- `STRIPE_*` — when billing lands.

For each new secret added, update this inventory + add to the rotation calendar.

---

## Schedule

Calendar reminders to set up:

| Cadence | Activity |
| --- | --- |
| Monthly | Backup restore drill — run the [procedure](#the-drill-we-run-monthly), log the outcome |
| Quarterly | Secrets rotation pass — all of `AUTH_SECRET`, `CRON_SECRET`, `RESEND_API_KEY` |
| Every 90 days | `PARTNER_CREDENTIAL_KEY` rotation review (rotate if anyone with access has left, otherwise skip) |
| Per-partner offboarding | Rotate that partner's webhook secret + revoke their App-Key |
| Per-engineer offboarding | Rotate `AUTH_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`. Review Vercel team access. |

---

## Post-incident template

Append a section to this file after every incident:

```markdown
## Incident YYYY-MM-DD — <short title>

**What happened:** 1-2 sentences

**Detection:** how did we find out

**Resolution:** what we did

**Impact:** which partners affected, how many bookings, how long

**Root cause:** the actual underlying reason

**What worked well:**

**What didn't:**

**Action items:**
- [ ] Owner — what — by when
```

Blameless. Focus on the system, not the human who pushed the button.

---

*Last updated: 2026-05-30. Update this doc on every operational change. If a new scenario arises that doesn't fit any of the above, add a section before merging the fix.*
