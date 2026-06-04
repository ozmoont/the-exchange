# Failure Modes

*What happens when a booking can't be filled, who sees what, and what's recoverable.*

*Source of truth: current code. Updated 2026-05-29.*

Use this document to answer "what happens if…" questions in partner conversations, and to onboard engineers to the failure surface area. Cross-references the Go-Plan for gaps that are still open.

---

## The seven failure modes

Every booking that doesn't complete successfully ends in one of these states. They're sequenced roughly by where in the lifecycle they fire — earliest failures first.

| # | Final status | Trigger | Recoverable? |
| - | - | - | - |
| A | `no_match` | Routing engine found zero eligible candidates | No (terminal) |
| B | `paused` | Kill switch engaged at routing time | Yes (manually) |
| C | `error_other` | All waterfall candidates errored, no auth pattern | No (terminal) |
| D | `error_auth` | All waterfall candidates errored, ≥1 auth-shaped | No (terminal) |
| E | `no_match` (post-reroute) | Accept window expired, no candidates remaining | No (terminal) |
| F | `failed` (post-reroute) | Accept window expired, hit max 5 reroute attempts | No (terminal) |
| G | `cancelled` or `failed` | Recipient fleet reported it mid-trip | Depends on the cancellation reason |

The first six are decisions our routing engine makes. The seventh is the recipient telling us about something that happened in their dispatch.

---

## A — Routing finds nothing eligible (`no_match`)

The originator pushed a booking, our engine looked for candidates. None passed all of: mutual allow ∧ within service radius of pickup ∧ supports the requested vehicle type ∧ supports the requested booking type (ASAP / pre-book).

### What the demand fleet sees
- Booking on `/bookings` with status badge **No match** in red
- Tooltip explainer: "No eligible partner fleet could take this job (no mutual allow / out of service area / wrong vehicle type)"
- Routing decision card on detail page: shows **"0 eligible fleets considered"** plus a fallback explainer
- Booking sits at no_match permanently — no retry

### What supply fleets see
Nothing. The routing engine never reached them. They have zero awareness this booking ever existed.

### What super admins see
- Counted in the **No match** stat card on `/distribution`
- Filterable list at `/bookings?group=no_match`
- Audit log: `transit.no_match` with reason

### What the originating iCabbi tenant gets back
Status webhook with `status: FAILED` to their `/bookings/status_update` endpoint. Their dispatcher's view shows the booking as un-fulfilled and falls back to their own driver pool (or surfaces "no driver available" to the passenger app).

### Recoverable?
No. Booking stays no_match forever. **If new partners onboard later, no retroactive routing happens** — see gap #2 below.

---

## B — Kill switch is on (`paused`)

A super admin engaged the network-wide kill switch (`/` dashboard, "Engage kill switch" button). Every new booking gets parked at `paused` status. In-flight bookings continue receiving status updates — only new routing is halted.

### What the demand fleet sees
- Status badge **Paused (kill switch)** in amber
- Tooltip: "Routing was halted by the network kill switch"
- Booking sits there indefinitely

### What supply fleets see
Nothing. Routing never reached them.

### What super admins see
- Red banner on dashboard: "Engaged — new bookings paused"
- Paused count in the Distribution stat cards
- Audit log: `kill_switch.on` with reason + actor

### What the originating iCabbi tenant gets back
**Today: nothing.** This is **gap #1 below** — paused bookings should send a `held` or `delayed` status back to the originator, but we currently just sit on them.

### Recoverable?
Manually:
- Admin disengages kill switch (`kill_switch.off`) — new bookings route normally, but **existing paused ones stay paused**
- No "resume all paused" admin action exists yet (gap #1)
- For now: each paused transit needs to be re-fired by an admin action that doesn't exist on the UI

---

## C / D — All waterfall candidates errored

Routing found candidates. We tried the first; it threw. Tried the second; also threw. Through all five candidates (`MAX_WATERFALL = 5`). None succeeded.

`error_auth` specifically when ≥1 error message matched `/401|403|auth/i`. Separated from `error_other` so super admins can spot credential-rot patterns versus generic adapter failures.

### What the demand fleet sees
- Status: **Routing error** (`error_other`) or **Partner auth error** (`error_auth`), both red
- Routing decision card: lists all 5 candidates tried, each with its error message:
  - "Auth failed → fell through" for 401/403s
  - "Adapter error → fell through" for everything else
- Exact error text shown inline (truncated to 200 chars)

### What supply fleets (the ones that errored) see
- Each candidate's failure is recorded against them
- `acceptanceRate` drops on the next 5-minute reliability recompute
- They take a routing-score penalty going forward
- **No proactive notification** that they fumbled — they only see the effect via lower future routing volume

### What super admins see
- The 37 errors from the recent fire-jobs run are this category
- Audit log records each individual waterfall attempt with error message
- Should investigate patterns — credential rot, network blips, adapter bugs

### What the originating iCabbi tenant gets back
`status: FAILED` via status_update webhook.

### Recoverable?
No automatic retry. Manual "route again" admin button doesn't exist — see gap #4.

---

## E — Accept window expired, no candidates remaining (`no_match` after reroute)

We pushed to fleet X. 90 seconds passed (ASAP) or 5 minutes (pre-book). They didn't advance the booking past `pushed`. The reroute engine kicked in:

1. Sent `cancelBooking` to fleet X (best-effort — they might be down)
2. Excluded fleet X plus any previously-attempted partners from candidate ranking
3. Re-ranked remaining candidates — found zero
4. Marked transit as `no_match`, cleared `acceptDeadline`

### What the demand fleet sees
- Status flipped from "Sent to fleet" → **No match**
- Routing decision card shows both:
  - Original waterfall attempts (the first push that succeeded)
  - **Auto-reroutes after acceptance timeout** section with a single entry: "Re-routed → no candidates remaining"
- Full audit trail of which fleet ghosted and why we couldn't recover

### What supply fleet X (the one that ghosted) sees
- Their `acceptanceRate` drops — this push counted as not-accepted
- Their `autoRerouteRate` increases
- Reliability penalty in routing increases — they rank lower next time
- If they were looking at their dashboard during the window, they see the booking briefly at `pushed` then disappear (cancelled on our side)

### What super admins see
- Audit log: `transit.rerouted` with reason `accept_window_expired_no_candidates`
- Ghost fleet's metrics worsen, visible on their partner detail page

---

## F — Accept window expired, hit max reroute attempts (`failed`)

We pushed to fleet X, timed out, rerouted to Y, Y timed out, rerouted to Z, Z timed out, … through 5 fleets. Hit `MAX_REROUTE_ATTEMPTS = 5`. Booking marked `failed`.

### What the demand fleet sees
- Status: **Failed** in red
- Routing decision card shows 5 reroute attempts in sequence, each with the timeout reason and the next fleet picked
- Booking is stranded, but the trace tells the full story

### What each supply fleet involved sees
- All 5 take an acceptance-rate hit
- They climb down the routing rankings together
- This is the closed feedback loop working: 5 unreliable fleets in a row → all penalised

### What super admins see
- Likely a **regional supply problem** — investigate why 5 fleets in this region can't accept fast enough
- Or a **routing config problem** — perhaps `bookingTypes` or `vehicleTypes` filtering is letting through ineligible candidates
- Audit log has the full chain via `transit.rerouted` × 5

### What the originating iCabbi tenant gets back
`status: FAILED`.

---

## G — Mid-trip cancellation / failure

The booking was successfully accepted. A driver was assigned. Maybe even en route or on-board. Then the recipient fleet sent a status webhook with `CANCELLED` or `FAILED`.

### What the demand fleet sees
- Status badge: **Cancelled** or **Failed** depending on which webhook arrived
- Event timeline shows the full history with timestamps — pushed → accepted → driver_assigned → cancelled
- Driver detail panel still visible (if `driverDetailsRequired=true`) — they see who the driver was that cancelled
- Fee snapshot still locked in (for billing dispute later)

### What the recipient fleet sees
Whatever they want. It's their cancellation. Our system just relays the status.

### What super admins see
- Audit log records the inbound webhook delivery
- Reliability metric: this counts against `completionRate` for the recipient
- A fleet with >10% mid-trip cancellation rate is a future "investigate" report candidate

### What the originating iCabbi tenant gets back
The CANCELLED / FAILED status from the recipient, mapped through our internal enum, forwarded as `status: CANCELLED` or `FAILED` via status_update webhook.

### Recoverable?
Depends:
- If cancelled by passenger (recipient's `BOOKER_CANCELLED`) — the demand fleet may surface this to the passenger
- If cancelled by driver — demand fleet might re-route to a different network booking
- If failed mid-trip (rare) — incident territory

We don't auto-retry these. The booking is dispatch-grade complete and any retry needs human judgment.

---

## What the demand fleet gets back, by failure mode

The status webhook we send back to the originator's iCabbi tenant:

| Failure mode | Internal status | Sent back as | Notes |
| - | - | - | - |
| A | `no_match` | `FAILED` | First-attempt no-match |
| B | `paused` | — | **Gap #1** — nothing sent back today |
| C | `error_other` | `FAILED` | All adapters errored |
| D | `error_auth` | `FAILED` | Subset of C, flagged separately for credential rot detection |
| E | `no_match` (post-reroute) | `FAILED` | After failed reroute |
| F | `failed` | `FAILED` | Hit max reroutes |
| G | `cancelled` | `CANCELLED` | Mid-trip |
| G | `failed` | `FAILED` | Mid-trip |

The passenger experience downstream: their dispatcher (iCabbi) shows "Sorry, we couldn't fulfil this booking" with no explanation. **Iterating on this copy is a future improvement** — see gap #3.

---

## Known gaps

These came out of this analysis. Each is a place a real partner conversation could fumble.

### Gap #1 — Paused bookings don't auto-resume

**Symptom**: Kill switch engages while a wave of bookings arrive. Admin disengages 10 minutes later. The bookings that landed during the pause stay at `paused` indefinitely. No webhook back to originator. Real fleets would see their dispatcher hanging.

**Severity**: High. Real fleets engaging us in pilot would hit this on day 1 of any incident.

**Fix scope**: ~2 hours.
- Track which kill switch toggle a paused booking belongs to
- When kill switch disengages, re-route every paused booking that was queued during the engaged window
- Send the originator `FAILED` immediately on engage if we're not going to auto-resume

**Recommended Sprint**: P0 hardening, slot into Sprint 2 or 3 of the Go-Plan.

---

### Gap #2 — `no_match` doesn't retry when new partners come online

**Symptom**: A booking in Bristol came in before we had any Bristol partners. It's marked `no_match`. Next week Bristol Star Cabs onboards. The original booking stays no_match forever — we never reconsider it.

**Severity**: Medium. Less common than #1; mostly an issue during early pilot when supply is thin in some regions.

**Fix scope**: ~3 hours.
- Background job that scans recent `no_match` transits (last 24h)
- Re-rank candidates; if eligible ones exist now, re-route
- Cap retries so a no_match doesn't bounce around forever

**Recommended Sprint**: P2 in Go-Plan (post-pilot).

---

### Gap #3 — Reroute transitions are invisible to the demand fleet

**Symptom**: Demand fleet pushed a booking to us. We routed to fleet X. X ghosted. We rerouted to fleet Y. Y completed it successfully. The demand fleet's iCabbi tenant only ever sees the booking as `pushed → completed` — no indication anything went sideways behind the scenes.

**Severity**: Low for iCabbi tenants (their dispatcher doesn't care which fleet ran the trip). **High for branded demand partners** (FreeNow / Karhoo aggregators that show driver detail to passengers) — the passenger's app would show driver X's name and car, then driver Y arrives.

**Fix scope**: ~1 hour.
- On reroute, fire a status webhook back to the originator: `recipient_changed` with new driver details
- Their adapter decides whether to surface this to the passenger
- Document the expected behaviour

**Recommended Sprint**: P1 once we onboard a non-iCabbi demand partner.

---

### Gap #4 — No admin retry button for failed transits

**Symptom**: A booking ends in `error_other` due to a transient issue (e.g. fleet X had a 30-second outage during our retry window). The booking is stuck. Admin would have to manually re-fire by creating a new transit.

**Severity**: Low for now (we don't have real-fleet traffic to make this routine). Medium during pilot.

**Fix scope**: ~1 hour.
- "Retry this" button on the transit detail page (super_admin only)
- Calls `routeBooking()` with the original payload, new transit id
- Audit-logs the manual retry

**Recommended Sprint**: P1 in Go-Plan, slot into Sprint 5 or 6.

---

### Gap #5 — Recipient gets no notice they were rerouted away

**Symptom**: We pushed a booking to fleet X. They ghosted. We sent `cancelBooking` (best-effort) and routed to fleet Y. Fleet X's dispatcher might still be trying to allocate a driver, unaware we've moved on.

**Severity**: Low. Best-effort cancel works in most cases. Race conditions exist when their dispatch is slow.

**Fix scope**: ~30 min.
- Make the cancel call retry-with-backoff up to 3 times
- Audit log the cancel outcome (success / timeout / unreachable)
- If cancel fails, flag the partner as "needs reconciliation" on the next reliability recompute

**Recommended Sprint**: P2, slot into reliability work.

---

## Operating principles (for the team)

When a real partner asks "what happens if…", here's the safe answer pattern:

1. **Look up the status** on `/bookings/[id]` — that tells you which of the seven modes you're in
2. **Open the routing decision card** — it shows every fleet considered and what went wrong
3. **Check the audit log** for the transit id — gives you the full action trail with timestamps
4. **If it's a recoverable mode (B, G)** and we have tooling for recovery, use it
5. **If it's a terminal mode (A, C, D, E, F)** and the demand fleet asks about the booking, you'll need to either manually re-fire it (Gap #4 makes this clunky today) or explain why it's stuck

When the demand fleet asks "why was my booking rerouted to fleet Y" — that's Gap #3 territory. Today we don't tell them. The honest answer is "fleet X didn't accept in time, our reliability engine routed it elsewhere". If they need this surfaced in real-time we owe them a webhook event.

---

## What this doc deliberately doesn't cover

- **Inbound webhook delivery failures** from the recipient side (covered by webhook delivery inspector at `/webhooks`)
- **Network-level outages** affecting our service (covered by future status page + DR procedures)
- **Billing reconciliation** failures (separate doc when reconciliation lands)
- **Compliance / regulatory failures** (covered by privacy + DPA work)

---

*Last updated: 2026-05-29. Update this doc on every failure-surface change. If a new failure mode arises that doesn't fit A-G, add it here before merging the code.*
