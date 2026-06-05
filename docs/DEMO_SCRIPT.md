# The Exchange — Demo Script

*The 10-minute walkthrough. Print this. Have it next to the laptop.*

*Last updated by Franko, end of session 3. Tested against the live URL.*

---

## Before you start (5 min)

1. Open three browser tabs in this order:
   - **Tab 1:** `https://the-exchange-z2wp.vercel.app/status` (the public proof-of-life — left open, refreshes itself)
   - **Tab 2:** `https://the-exchange-z2wp.vercel.app/` (the dashboard)
   - **Tab 3:** `https://the-exchange-z2wp.vercel.app/distribution` (the map view)

2. Run the state refresh so the dashboard tells a complete story:
   ```bash
   cd ~/Desktop/ClaudeCode/the-exchange
   pnpm demo:refresh
   ```
   Takes ~30 seconds. Idempotent — safe to re-run if needed. After it
   finishes you should see, on the dashboard:
   - "Pending applications" banner (2 fleets waiting)
   - "Auto-suspended partners" banner (2 fleets)
   - "Reconciliation drift" banner (1 booking flagged)
   - "Recent activity" populated
   - Stat cards showing routed / completed / failed
   
   And `/status` should show: all systems operational, > 0 synthetic in last 24h, activity counts non-zero.

3. Make sure your speaker volume isn't on. If something fails mid-demo, narrate it — don't go silent.

---

## The pitch — 30 seconds

> *"iCabbi connects fleets one-to-one. The Exchange connects fleets
> many-to-many. We sit beside iCabbi as the decision layer — routing
> bookings to the best partner based on geography, fees, and reliability —
> and we bridge iCabbi tenants to non-iCabbi systems like CMAC and FreeNow
> under one rulebook."*

If asked "why doesn't iCabbi just do this themselves?": iCabbi's existing
partnership-coid mechanism is the **transport**, not the **decision**. We
sit on top, picking who gets each job and audit-logging the trip.

---

## Act 1 — Public proof of life (1 minute)

**Tab 1: `/status`** ←

> *"Before we sign in, this is what we'd give a pilot fleet to bookmark.
> Anyone with the URL can see whether The Exchange is up — no login. No
> personal data. Just system health and aggregate counts."*

Point out:
- The green dots — routing engine, queue drain, reliability scoring, fee reconciliation
- The synthetic monitor bar — 24 hourly buckets, each one a green tile if a synthetic test booking passed that hour. "We fire a fake booking every hour through the same code paths as real traffic. If it fails, we know before anyone else does."
- The activity row — routed last 1h / 24h / completed / in-flight / active partners

If a fleet asks "are you up right now?" — this is the answer. Page
auto-refreshes every 30s.

---

## Act 2 — The network overview (2 minutes)

**Tab 2: `/`** (the dashboard)

> *"This is what a super admin sees when they sign in. The network
> overview."*

Point out, in order:
1. **The banner stack** (if `demo:refresh` worked, you'll have 3 banners):
   - Pending applications — "fleets that have applied via /signup and are waiting for approval"
   - Auto-suspended partners — "fleets whose acceptance rate fell below 40% over 50+ bookings. The system suspended them automatically. A human re-activates once they've recovered."
   - Reconciliation drift — "completed bookings where the two partners' billed totals disagree with our fee snapshot by more than 5%. Catches invoice disputes before they happen."
2. **The stat cards** — active partners, sent to fleet, completed, failed/no-match. Each card is a clickable link to filtered /bookings.
3. **Kill switch** — "one button halts new bookings instantly. In-flight bookings continue receiving status updates so nothing strands. When we flip it back off, every paused booking gets replayed through routing automatically — no manual intervention."
4. **Recent activity + audit log** — every consequential action is logged with actor + before/after JSON.

Don't actually engage the kill switch unless asked. Have the talking point ready.

---

## Act 3 — Distribution and routing (3 minutes)

**Tab 3: `/distribution`**

> *"This is where it gets fun. This is the map of every active fleet in
> the network — by geography, with pickup heat. Watch this."*

1. **The UK map** — show the cluster around London, Manchester, Birmingham. Each dot is a fleet. The heatmap is recent pickup density.
2. **The stat cards** — same pattern as the dashboard but for routing-level outcomes.
3. **The top-winning fleets table** — by job count, with reliability column. Point out: "the reliability number isn't a guess. It's a 7-day rolling acceptance rate. Routing weighs this — low-reliability fleets get penalised in candidate ranking."

**The big moment — click "Fire 50 jobs":**

> *"This fires 50 realistic bookings through the routing engine right
> now. Geographic distribution, vehicle types, fee snapshots, the lot.
> Watch the dashboard."*

Click. Watch the page reload with the outcome banner. Switch back to
Tab 2 (dashboard) — show the stats moving in real time.

> *"In production those 50 bookings would have hit our webhook endpoint
> from a real iCabbi fleet. Routing decision happens in milliseconds —
> nearest fleet that's allowed to receive from the originator, weighed by
> reliability and fee."*

---

## Act 4 — The audit trail (2 minutes)

**Click on one of the routed bookings in /bookings** (any in_flight one).

> *"This is what partners would invoice off. The decision trace."*

Point out:
1. **Status timeline** — every state transition with timestamp.
2. **Routing decision trace** — "the waterfall. We tried fleet A, B, C. Here's why we picked the one we did. Geography score, fee, reliability penalty. Reroute attempts if the first pick didn't accept in time."
3. **Fee snapshot** — "this is the receipt of what each side gets paid. Captured at routing time. Non-retroactive. Travels with the booking."
4. **Reconciliation panel (on completed bookings)** — "after a booking completes, we ask both adapters what they actually billed and compare. Drift > 5% gets flagged for super-admin review. The first real iCabbi paired payload we analysed had a £10 processing-fee discrepancy that's exactly what this catches."

If the booking has a reroute history, point it out. The reroute engine
is the biggest differentiator over iCabbi's native coid mechanism — coid
can't reroute, it only delivers one hop.

---

## Act 5 — The integration (1.5 minutes)

**Click on a partner → "Integration" tab**

> *"This is where the iCabbi credentials go. Right now this fleet is on
> the mock adapter — every routing call goes through a mock iCabbi
> client. The keys are landing today, so this is what we'd do next."*

Point out the **"What happens when you click Connect"** preview block.
Walk through the five steps:
1. AES-256-GCM encryption of App-Key + Secret-Key
2. Per-fleet webhook signing secret generated, shown once
3. Auto-registration with iCabbi's webhook subscription API
4. Adapter flips from `mock_icabbi` to `icabbi`
5. Audit-logged

> *"As soon as I paste in App-Key and Secret-Key, this becomes live
> traffic. Right now I'm not going to do that — we want to do the first
> real connect deliberately, not on a demo. But the path from here is
> two text fields and a button."*

**Cover for "do you have iCabbi keys?":**

> *"They're landing today. The integration is fully built and tested
> against the real iCabbi API spec — we've already analysed real iCabbi
> paired webhook payloads (247 Birmingham and Take Me) to validate the
> adapter. The only thing we don't have until end of day is one friendly
> tenant volunteering App-Key/Secret-Key for a real-credential test."*

---

## Wrap — 30 seconds

> *"Engineering bottleneck is cleared. Two things are gating a pilot:
> 1. One friendly iCabbi tenant for the real-credential test — keys
>    landing today.
> 2. The eight sponsor decisions in `GO_LIVE_READINESS.md` — pricing,
>    pilot scope, data-controller posture.
>
> The 12-week sprint plan to a paying pilot fleet is in `GO_PLAN.md`."*

---

## Contingency answers

**"What happens if a booking doesn't get accepted?"**
> *"90-second acceptance window for ASAP, 5 minutes for pre-book. If
> the recipient doesn't move it past 'pushed' in that window, our reroute
> engine cancels on the original side and pushes to the next eligible
> candidate. Up to 5 reroutes before we drop to 'no_match' and tell the
> originator we couldn't fill it. See `FAILURE_MODES.md` for the full
> picture."*

**"What if a partner pretends a booking is accepted but never delivers?"**
> *"The reliability score is computed from real outcomes — bookings that
> actually progress to 'accepted' and 'completed'. If a partner accepts
> but the booking sits, the completion rate drops, the auto-reroute rate
> climbs, the next time routing scores them they get penalised. If the
> acceptance rate falls below 40% over 50 pushed bookings, they
> auto-suspend. Closed loop, no human in it."*

**"How do you handle PII?"**
> *"Driver details are opt-in per partner — `driverDetailsRequired` is a
> flag on the partner row. Default off. When off, the normaliser drops
> the driver block from the payload we send back to the demand fleet.
> Most fleets don't need it. Corporate / VIP / regulated routes opt in."*

**"What about security?"**
> *"Webhooks are HMAC-SHA512 signed per partner — no shared global
> secret. We verify signature + check `sent_at` is within 5 minutes
> (replay protection) + dedupe by event id. Credentials are AES-256-GCM
> encrypted at rest. Rate limiting on every webhook and admin write
> route. Auth lockdown is on the P0 list — pen test booked for week 8."*

**"How does this make money?"**
> *"Per-booking fee snapshot — send fee (originator earns) and receive
> fee (recipient pays). Defaults are 20p send, 40p receive at the
> network level, plus optional pair-level overrides. Trip-level fees
> (tech, booking, admin) flow through too. Pricing model and our take
> rate are open decisions for the sponsor — see GO_LIVE_READINESS.md
> Section 1."*

**"What happens if your service goes down?"**
> *"Two things. First — in-flight bookings continue receiving status
> updates because the webhook routes are stateless. Second — the kill
> switch parks all new routing, in-flight unaffected. We have a
> structured-log + Sentry-ready observability hook (one `pnpm add` away
> from live alerts) and synthetic monitoring so we'd know before our
> partners would."*

**Anything you don't know:** *"Good question. I'll come back to you
within an hour — let me check the docs and the code so I give you the
right answer, not the fast one."* (Then actually do it.)

---

## If the demo derails

- **A page errors:** Switch to Tab 1 (`/status`). Show "this is the
  health signal — even if I'm clicking around live and something
  breaks, the public status page is the source of truth, not me."
- **Kill switch accidentally engages:** Flip it back. The resume banner
  will appear showing how many bookings were resumed. That's actually
  good — it demos the recovery flow.
- **Asked something we haven't built:** "Not in MVP scope. See `STRATEGY.md`
  Section 2 — explicitly out of scope. Surcharge engine, cancellation
  fees, ML routing, automated certification — all parked deliberately."
