# Idempotency model

The Exchange handles every write path defensively against duplicate inputs. Webhooks retry. Cron jobs overlap. Admins double-click buttons. This doc is the canonical reference for every dedup point, so new write paths can either reuse the existing patterns or add a new one consciously.

## TL;DR

| Surface | What's deduped | How |
| --- | --- | --- |
| Inbound webhook delivery | (source, sourceEventId) | Unique constraint on `webhook_deliveries` |
| Inbound webhook freshness | sent_at within 5 min | sent_at window check in route handler (P0-5) |
| Transit creation | (originator, originatorBookingExternalId) | Unique constraint on `transits` |
| Async queue drain | One worker per transit | Conditional UPDATE (received → routing) |
| Reroute | One reroute per transit per cycle | Status check + acceptDeadline gate |
| Reconciliation | One reconcile per completed transit | reconciledAt IS NULL filter |
| Reliability recompute | At most once per 5 min | networkControls.lastReliabilityComputeAt cooldown |
| Auto-suspend | Doesn't re-suspend manually-activated partners | autoSuspendCooldownUntil window |
| Outbound event delivery | Stable event id per logical event | SHA-256(eventKey) → event_id |
| Fee snapshot | Deterministic from inputs | `makeSnapshot()` is pure (property-tested) |

---

## Layer 1: HTTP edge

### Inbound webhooks

`POST /api/webhooks/ingest/[partnerId]` defends against:

1. **Stale replay** — `sent_at` must be within `WEBHOOK_MAX_AGE_MS` (default 5 min). Reject 401 outside the window. (P0-5)
2. **Same-event replay** — `(source, sourceEventId)` is unique on `webhook_deliveries`. Second INSERT fails; we treat it as duplicate and 200-ack.
3. **HMAC integrity** — payload signed with partner's `webhookSecret`. Mismatched signature: 401.
4. **Rate limit** — 60 events/minute per partner via the Postgres-backed counter. (P0-4)

What this combination achieves: a captured webhook is unreplayable after 5 minutes; an in-window replay is dedup'd by event id; a tampered payload fails HMAC; a misbehaving partner is shed-loaded.

### Magic-link login

`/login` server action defends against:

1. **Rate limit** — 5/hour per email. Silently fails closed if exceeded (to avoid leaking allowlist membership). (P0-4)
2. **Token freshness** — magic-link tokens expire in 15 min and are single-use (`usedAt` set on first consume).

### Cron route

`/api/cron/process-queue` defends against:

1. **Unauthorized invocation** — either `x-vercel-cron: 1` (Vercel-set) or `Authorization: Bearer $CRON_SECRET`.
2. **Concurrent invocations** — see Layer 3 below.

---

## Layer 2: Domain idempotency (DB)

### `transits` table

Unique constraint: `(originator_partner_id, originator_booking_external_id)`. Two calls to `insertTransit()` (or `routeBooking()` / `receiveBooking()`) with the same (originator, external_id) pair find the existing row and return it instead of creating a duplicate.

This is why **the entire routing path is safe to replay**. `pnpm fire-jobs` running into a network blip can be retried — already-routed transits are detected and skipped.

### `webhook_deliveries` table

Unique constraint: `(source, source_event_id)`. INSERT-with-conflict-detection on every inbound delivery. Source convention: `ingest:{partnerId}` for inbound, `outbound:{partnerId}` for outbound.

### `transit_events` table

NOT unique-constrained — same status can be written multiple times legitimately (e.g. status moves through `accepted → driver_assigned → accepted → driver_assigned` if the partner re-assigns a driver). Callers are responsible for deciding whether to deduplicate.

### `audit_log` table

NOT deduplicated — every admin action gets a row even if logically the same. Audit log is a tape, not a state.

---

## Layer 3: Concurrency

### Async queue drain

`processReceivedTransits()` is called by both Vercel cron (every minute) and the demo background tick (~20s on the live URL). Two workers picking up the same row would double-process it.

Defense: the worker doesn't `SELECT … FOR UPDATE` or claim a lock. Instead, the row is claimed via a **conditional UPDATE**:

```sql
UPDATE transits
SET status = 'routing', updated_at = now()
WHERE id = $1 AND status = 'received'
RETURNING id
```

Postgres guarantees this is atomic. The transaction that commits first wins the row; the other sees empty `RETURNING` and skips. `outcomes.skipped` counts these.

### Reliability recompute

Runs on every page render via `maybeRecomputeReliability()`. Defends against doing the work too often via a 5-minute cooldown on `networkControls.lastReliabilityComputeAt`. The cooldown row is updated FIRST (under a race, multiple concurrent calls all set the same now-ish timestamp, only one passes the gate, the others see the updated cooldown and skip).

### Reconciliation

Same pattern — `networkControls.lastReconciliationRunAt` 1-hour cooldown. Plus the per-row filter `reconciledAt IS NULL` means a row that was reconciled by a prior run is skipped.

### Auto-suspend

Doesn't have a cooldown of its own — runs after every reliability recompute (so every ~5 min). What protects against thrash: the `autoSuspendCooldownUntil` partner column. When a human manually re-activates a partner via `/partners`, the action sets cooldown = now + 7 days. `enforceReliabilityThresholds` skips partners whose cooldown hasn't passed. Without this, a fleet manually re-activated at low acceptance rate would be re-suspended in the next 5 minutes on the same stale data. (P1-E3)

---

## Layer 4: Outbound deliveries

### Outbound webhook event ids

`sendOutboundEvent()` derives `event_id` deterministically from an `eventKey` parameter. Same key → same id every retry.

```ts
const eventId = createHash("sha256").update(eventKey).digest("hex").slice(0, 32);
```

Caller responsibility: pick a stable key that uniquely identifies the **logical event**. For the reroute case:

```ts
const eventKey = `${transitId}:transit.rerouted:${rerouteCount}`;
```

A retry of the same delivery uses the same key, produces the same event_id, lets the partner dedupe on their side.

When `eventKey` is omitted, the helper falls back to `SHA-256(originator, eventType, stableStringify(payload))`. This dedupes only if the payload is bit-identical across retries — fine for static events, fragile if anything mutates between retries.

### Adapter `createBooking`

iCabbi's `POST /v2/bookings/add` accepts an `external_reference` field that we always populate with `originatorBookingExternalId`. We rely on iCabbi treating that as idempotent on their side. To confirm: send the same booking twice and verify only one trip is created on their dispatch.

**Not yet verified end-to-end against a real iCabbi tenant** — first real-credential test will confirm. If iCabbi doesn't treat external_reference as idempotent, we add a pre-check: read the transit's `recipientBookingExternalId`; if set, skip the createBooking call.

---

## Layer 5: Pure-function determinism

### `makeSnapshot()` in lib/fees.ts

The fee snapshot is the reference for billing reconciliation. Two snapshots taken at the same instant for the same booking MUST be byte-identical, or partners will argue about which is the truth.

Property-tested in `src/lib/__tests__/fees.test.ts`:

- Same inputs across 100 invocations → identical output
- Different fare → output diverges
- Different config id → only `resolvedFromFeeConfigId` changes
- Wall-clock drift doesn't affect the snapshot (no `Date.now()` inside)
- Combinatorial grid: every (bookingType × channel × fare) pair runs through and must match

If anyone reaches for `Date.now()`, `crypto.randomUUID()`, or `Math.random()` inside `makeSnapshot()`, the property tests catch it.

---

## How to add a new write path

Before merging a new path that writes to the DB or fires external traffic, walk this checklist:

1. **Can the same logical input arrive twice?** (Almost always yes.)
2. **What's the natural dedup key?** A booking id, an event id, a (sender, sequence_number) pair.
3. **Pick the layer:**
   - HTTP-level retries → Layer 1 (rate limit + freshness + HMAC)
   - Domain entity creation → Layer 2 (unique constraint on the dedup key)
   - Background workers → Layer 3 (conditional UPDATE claim or cooldown row)
   - Outbound deliveries → Layer 4 (stable id derivation)
   - Pure transforms → Layer 5 (write the property test first)
4. **Document it here.** Update the TL;DR table.

A write path with no dedup story should not ship.
