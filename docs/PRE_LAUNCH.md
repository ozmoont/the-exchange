# Pre-launch checklist

The product is feature-complete against the MVP cut in `docs/STRATEGY.md` and ready for pilot once iCabbi credentials arrive. This document tracks what's already done and what's left between "running on the founder's laptop" and "live in front of an iCabbi fleet".

## What's MVP-ready already

### Product
- All four locked MVP features: partner directory + bilateral allow/block, routing + status sync, per-partner trip and network fees travelling with the booking, admin dashboard + kill switch.
- **Pair-level fee overrides** UI at `/fees/[recipientId]/pair` — handles King County WAV and Blue Line affiliate billing scenarios.
- **Webhook delivery inspector** at `/webhooks` — every inbound webhook receipt is searchable post-hoc.
- **Suspend/activate quick action** on the partners list — one-click status flip without going through the edit page.

### Real-API integration
- `ICabbiAdapter` built against the actual iCabbi Swagger contract — App-Key/Secret-Key header auth, real endpoint paths (`/v2/bookings/add`, `/v2/bookings/cancel/{trip_id}`, `/v2/bookings/status_update`), real `BookingSimpleCreate` body shape, response envelope unwrapped per their `{ version, code, body, warnings, nonce }` standard.
- **Real per-partner inbound webhook receiver** at `/api/webhooks/ingest/<partnerId>` with HMAC-SHA512 signature verification (matches Karhoo/iCabbi spec: lowercase hex of raw body in `X-Karhoo-Request-Signature`).
- **Real event handling** for `TripStatus`, `DriverDetails`, `FinalFareReleased`, `DriverPositionChanged`. Status names mapped to our internal lifecycle (`CONFIRMED → accepted`, `DRIVER_EN_ROUTE → en_route`, `ARRIVED → en_route`, `POB → on_board`, `COMPLETED → completed`, `*_CANCELLED → cancelled`, `NO_DRIVERS_AVAILABLE / FAILED → failed`).
- **Webhook subscription auto-registration** with iCabbi when admin saves credentials, with manual-fallback UI when it fails.
- **Webhook secret rotation** re-registers automatically with iCabbi.

### Auth + RBAC
- Magic-link auth with email allowlist; HMAC-signed session cookies.
- **Three roles**: super_admin, fleet_admin, fleet_user — backed by `users` table with optional `partnerId` scoping.
- **`/users` admin page** for super admins to invite, role-change, and revoke users.
- **Defense-in-depth scoping** on partner detail, edit, and transit detail — fleet roles can't view another partner's data even by guessing the URL.
- **Bootstrap promotion**: the first email from `ALLOWED_EMAILS` to sign in is auto-promoted to super_admin. Seeded by `pnpm seed`.

### Security
- Credentials encrypted at rest with AES-256-GCM (`PARTNER_CREDENTIAL_KEY`).
- HMAC-signed session cookies, edge-runtime verification on every request.
- HMAC-SHA512 webhook signature verification with timing-safe compare.
- Audit log on every consequential admin action with full before/after JSON, never including secret values (only presence flags).
- Webhook signature validates against the raw body bytes — no parse-then-stringify dance that would break verification.

### UX
- **Public landing page** at `/` for unauthenticated visitors with hero, three-step explainer, and trust strip.
- **Signed-in dashboard** with stat cards, recent-activity feed, audit log preview, and kill switch panel.
- **Tailwind design system** with semantic tokens and reusable component classes — applied across landing, dashboard, users admin, partners list, audit log, bookings list, login, webhooks inspector, pair-fee overrides. (Partner detail, edit, integration, and per-pair rule editor still use the original inline styles — functional but visually inconsistent. Convert as the next polish cook.)
- **Role-adaptive nav and views**: super admins see Fees/Audit/Webhooks/Users; fleet roles see a clean "who you work with" connections list instead of the full matrix.
- **Transit lifecycle simulator** on transit detail pages — drives the same `forwardStatusUpdate` path real iCabbi webhooks hit.

### Ops
- `/api/health` endpoint with DB ping.
- `vercel.json` configured for Next.js + auto schema-push on deploy.
- `docs/DEPLOY.md` walkthrough — Neon DB, Vercel env vars, Resend setup, post-deploy smoke.
- Smoke test (`pnpm smoke`) walks Dublin→Cork, Dublin→CMAC prebook with fees, and idempotent redelivery.
- Vitest unit tests for fee math and adapter contract conformance.

## Outstanding for production cutover

### Required before pilot

- [ ] **Deploy to Vercel.** Follow `docs/DEPLOY.md`. Roughly 30 minutes the first time.
- [ ] **Set production env vars** (full list in DEPLOY.md). The two secrets to generate fresh: `AUTH_SECRET` and `PARTNER_CREDENTIAL_KEY`. **`PARTNER_CREDENTIAL_KEY` cannot be rotated without re-encrypting `partners.credentials`.**
- [ ] **Connect a real iCabbi tenant.** When sandbox App-Key/Secret-Key arrive: partner detail → "Connect iCabbi" → paste → save. Webhook auto-registers; manual fallback UI handles any iCabbi-side hiccup.
- [ ] **First real end-to-end booking** from Dublin Cabs (live tenant) through routing to a receiver. Walk through the status lifecycle via real iCabbi webhooks landing on `/api/webhooks/ingest/<partnerId>` and surfacing on `/webhooks`.

### Strongly recommended

- [ ] **Confirm `BookingCreated` mechanism with iCabbi.** Karhoo's documented webhook set lists only lifecycle events. There's no documented event for "trip marked for the network." The `kind: "create"` branch in the route handler is wired and ready, but won't fire until iCabbi confirms how inbound network bookings reach us. Until then, all real iCabbi traffic exercises the *outbound* path (we create on receiver, status flows back).
- [ ] **Confirm `POST /bookings/add` response shape** with a live iCabbi tenant. Adapter tries `trip_id`, `tripId`, `id`, `booking_id`, `bookingId` — first real booking will pin the right field.
- [ ] **Verify webhook auto-registration endpoint.** Adapter calls `POST /v2/webhooks/register` per Karhoo's spec. If iCabbi's path differs in their sandbox, adjust the URL in `src/adapters/icabbi.ts` `registerWebhookSubscription`.

### Nice-to-have polish

- [ ] **Convert remaining pages to Tailwind**: partner detail, edit, integration, per-pair rule editor. Currently inline-styled — functional, visually inconsistent with the new look.
- [ ] **Trigger.dev (or Inngest) for durable outbound retries** when our adapter call to a receiver fails. Right now routing catches errors and marks the transit `error_other` — no automated retry. Wire when needed.
- [ ] **Webhook rate limiting**. iCabbi's retry policy is bounded (3 attempts) and idempotency already deduplicates — not blocking, but a hard cap per partner per minute would defend against amplification scenarios beyond Karhoo's documented retries.
- [ ] **Better dashboard analytics**. Current stats are point-in-time; time-series volume + per-partner success rate would be useful once real traffic exists.
- [ ] **Live activity ticker** on the dashboard (poll or SSE) so status changes appear without manual refresh.
- [ ] **Webhook delivery outcome column** — right now `/webhooks` shows receipts; would be useful to also show whether each was applied, orphaned, or rejected (currently logged but not stored).

## Operational reminders

- **Encryption key rotation is destructive.** Changing `PARTNER_CREDENTIAL_KEY` without re-encrypting `partners.credentials` rows makes every connected partner un-decryptable. They'd need to reconnect. If rotation is required, write a one-shot script that decrypts with the old key and re-encrypts with the new one.
- **The kill switch on `/` halts NEW bookings.** In-flight transits continue receiving status updates so nothing strands.
- **Audit log retention is forever** by design. No automatic cleanup. GDPR DSAR or retention rules would be a separate workstream.
- **Secrets never appear in audit log entries** — only `hasSecretKey: true`-style presence flags. Verify via `/audit` if in doubt.
- **`webhook_deliveries` is the idempotency table.** Deleting a row lets that envelope id be replayed. Use `/webhooks` for read-only inspection; use `pnpm db:studio` for deeper edits.

## Smoke checklist post-deploy

After Vercel deploy succeeds, walk this list against the live URL before sharing it.

1. `curl https://<your-domain>/api/health` returns 200 with `db.status: "ok"`.
2. Unauthenticated visit shows the public landing page.
3. Sign in with your `ALLOWED_EMAILS` email. Magic link arrives via Resend (or in Vercel function logs if `RESEND_API_KEY` is unset).
4. You land on the signed-in dashboard with your email + super_admin role in the nav.
5. `/partners`, `/rules`, `/fees`, `/audit`, `/bookings`, `/webhooks`, `/users` all render.
6. `/users` → invite a test fleet_user assigned to one of the seeded partners. Sign out, sign in as that user, verify they see only their partner everywhere.
7. Connect a real iCabbi tenant on a partner. Verify webhook auto-registration outcome banner.
8. Send a test booking through the routing engine. Verify the transit appears on `/bookings`. Walk it through the status lifecycle via the transit detail page simulator.
9. Verify `/webhooks` shows receipts as they arrive (after iCabbi sends real events).
10. Verify `/audit` shows the connect + invite + status changes from steps 6–8.

If every step passes, the pilot is unblocked on our side — only the iCabbi-side answers (BookingCreated mechanism, sandbox credentials) remain.
