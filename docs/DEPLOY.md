# Deploy guide — Vercel

End-to-end walkthrough from "running on my Mac" to "shareable URL Frank can click". Roughly 30 minutes the first time.

## Prerequisites

- The repo is pushed to GitHub. If not yet: `git init && git add . && git commit -m "initial" && git remote add origin <your-repo> && git push -u origin main`.
- A [Vercel](https://vercel.com) account (free Hobby tier is fine).
- A hosted Postgres. Either [Neon](https://neon.tech) free tier or Vercel Postgres. Neon is simpler — these instructions assume Neon.
- A [Resend](https://resend.com) account if you want magic links to actually email (otherwise they just print to the server log, which is fine for testing but not for inviting Frank).

## 1. Create the Neon database

1. neon.tech → "Create project". Name it `the-exchange`. Region: closest to your Vercel region (`AWS eu-west-1 (London)` if you're using Vercel's default).
2. On the project dashboard, copy the connection string from the "Connection details" panel. It looks like:
   `postgresql://user:pass@ep-something-1234.eu-west-2.aws.neon.tech/neondb?sslmode=require`

## 2. Push the schema

From your local machine (one-time, against the production DB):

```
DATABASE_URL='<paste-your-neon-string>' pnpm db:push
```

Confirm all tables created (10 tables: partners, partner_rules, fee_configs, transits, transit_events, audit_log, webhook_deliveries, network_controls, magic_links, auth_sessions, users).

> **DO NOT run `pnpm seed` against production.** The seed wipes every table (partners, rules, fees, transits, audit log, users, webhook deliveries) and inserts demo data including fake transits and audit entries. It's a local-dev/demo tool only. The production DB stays empty after `pnpm db:push` until you add partners and invite users through the UI.

## 3. Generate production secrets

You need fresh values for two secrets — do not reuse the dev ones.

```
openssl rand -base64 32    # AUTH_SECRET — for session cookie HMAC
openssl rand -base64 32    # PARTNER_CREDENTIAL_KEY — for at-rest encryption
```

Save both safely. **`PARTNER_CREDENTIAL_KEY` cannot be rotated without re-encrypting `partners.credentials` rows** — once a partner connects, this key is sealing their App-Key and Secret-Key.

## 4. Set up Resend (optional for first deploy)

Skip this section if you're fine with magic links printing to Vercel function logs for now. To actually send emails:

1. resend.com → API Keys → create one. Copy it.
2. (Optional but recommended) verify a domain you control. Until then, magic-link emails come from `onboarding@resend.dev` which works but looks unofficial.

## 5. Create the Vercel project

1. vercel.com → "Add New" → "Project" → import your GitHub repo.
2. Framework preset: Next.js (auto-detected).
3. Build command: leave default — `vercel.json` already sets `pnpm db:push && pnpm build` so future schema changes auto-apply on deploy.
4. **Before clicking Deploy**, click "Environment Variables" and add:

| Key | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Neon connection string | From step 1 |
| `AUTH_SECRET` | First openssl output | From step 3 |
| `PARTNER_CREDENTIAL_KEY` | Second openssl output | From step 3 — DO NOT lose |
| `APP_URL` | `https://your-project.vercel.app` | Vercel assigns this — fill in after first deploy if you don't know yet |
| `ALLOWED_EMAILS` | `you@yourdomain.com` | Comma-separated bootstrap allowlist; first sign-in here is auto-promoted to super_admin |
| `RESEND_API_KEY` | Your Resend key (optional) | Without it, links print to function logs |
| `AUTH_EMAIL_FROM` | `The Exchange <login@yourdomain.com>` | Optional; only if you verified a domain with Resend |
| `ICABBI_API_BASE_URL` | `https://api.icabbi.com/v2` | Override only if iCabbi gives you a sandbox URL |
| `NETWORK_KILL_SWITCH` | `false` | Can also toggle from the UI |

5. Click "Deploy". First build takes ~2-3 minutes.

## 6. Post-deploy smoke

Once the deploy is green:

1. **Healthcheck:** `curl https://your-project.vercel.app/api/health` should return 200 with `db.status: "ok"`.
2. **Landing page:** open the URL in a browser. You should see the public landing page with "Sign in" CTAs (because you're not authed yet).
3. **Sign in:** click Sign in, enter your `ALLOWED_EMAILS` email. Check inbox (or Vercel function logs if Resend isn't configured) for the magic link. Click it.
4. **You land on the dashboard.** Your role auto-promoted to `super_admin` on first login because no users existed. The nav shows your email and role.
5. **Invite Frank:** `/users` → invite frank@icabbi.com as a `super_admin` (or as a `fleet_admin` if you want to scope him to one specific iCabbi tenant once it's set up).
6. **Connect a real iCabbi tenant:** when you have sandbox App-Key/Secret-Key, hit a partner's "Connect iCabbi" link and paste. The page attempts webhook auto-registration with iCabbi; if it succeeds, the integration is live end-to-end.

## 7. Update `APP_URL` if it was wrong

If you set `APP_URL` to a guess and Vercel assigned a different domain, update it now. Otherwise magic-link URLs and webhook URLs will point at the wrong host.

```
Vercel project → Settings → Environment Variables → APP_URL → edit → redeploy
```

## What happens automatically on each subsequent deploy

- `vercel.json` says `buildCommand: "pnpm db:push && pnpm build"`. So pushing a schema change to GitHub auto-applies it to your Neon DB on deploy. This is fine for additive changes (new columns nullable, new tables). For destructive changes (drop, rename, type-change), the build will succeed but you may have downtime — see PRE_LAUNCH.md for the additive-first migration pattern.
- Webhook URLs given to iCabbi don't change on deploy because they're built from `APP_URL`, which you set once and forget.
- Sessions persist across deploys because session cookies are HMAC-signed and the DB-backed session table outlives any single deploy.

## Common deploy issues

**Build fails with `DATABASE_URL is not set`.** You added the env var but didn't tick the "Production" environment scope when adding it. Edit the var and add Production.

**Healthcheck returns 503 with `getaddrinfo ENOTFOUND`.** Your `DATABASE_URL` host is wrong, or you copied the Neon string without `?sslmode=require`. Re-copy from Neon and update the env var.

**Sign-in redirects to `?error=not_on_platform`.** Your email isn't in `ALLOWED_EMAILS`. Update the env var, save, redeploy (or just wait — Vercel hot-reloads env without a rebuild).

**Magic link from Resend lands in spam.** Verify your sender domain in Resend and update `AUTH_EMAIL_FROM`.

**Webhook auto-registration with iCabbi fails on partner connect.** Expected for now — iCabbi's webhook register endpoint may not be open in their public sandbox. The credential save still works; the UI shows the URL + secret for manual registration with iCabbi's integration team.

## Rollback

Vercel keeps every deploy. If something goes wrong:

1. Project → Deployments → find the last good deploy → "Promote to Production".
2. If the issue is a schema change, you may need to manually run a rollback migration against Neon before reverting code.
