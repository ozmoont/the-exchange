# Design System Audit — The Exchange

*Audit date: 2026-05-29 · Auditor: Derek (Design)*

## Summary

**Components reviewed**: 14 distinct UI primitives in active use · **Issues found**: 23 · **Overall score**: **62/100**

The Exchange has a thoughtful starting foundation — semantic colour tokens (`ink`, `surface`, `success`/`danger`/`warning`/`info`), a small set of `@layer components` classes (`btn`, `card`, `input`, `badge`, `stat`), and consistent focus-visible styling. But the system has aged unevenly: newer pages have drifted toward raw Tailwind palette colours and arbitrary pixel values, older pages never got the Tailwind conversion at all, and the same conceptual component (e.g. a stat card) exists in five different implementations across five files.

The biggest single issue is **5 nearly-identical "stat card" components** (`Stat`, `StatCard`, `StatCardLink`, `StatLink`, `MetricCard`) scattered across the app. Consolidating those is the highest-leverage fix in this audit.

The second biggest is **2 pages still using inline `style={{}}` and hardcoded hex** (`/fees` and `/partners/new`), which means changing a brand colour requires hand-editing those files even though the rest of the app picks it up from a token.

---

## Token coverage

| Category | Defined in tokens | Hardcoded / arbitrary instances found |
| --- | --- | --- |
| Colors — semantic | ✅ 9 tokens (`ink`, `ink-muted`, `ink-subtle`, `surface*`, `accent`, `success/warning/danger/info` + `-fg`) | **48 raw palette uses** (`yellow-300/400/900`, `red-200/300/500/600/700/800`, `green-300/500`, `amber-500/900`, `sky-500`, `blue-200`, `slate-200`) |
| Colors — semantic borders | ❌ no border tokens for warning/success/danger/info | All warning panels reach for raw `border-yellow-*`, danger panels for `border-red-*` (inconsistent 300 vs 400 vs 500) |
| Spacing | ❌ none beyond Tailwind defaults | **~30 arbitrary px values** (`w-[140px]`, `max-w-[260px]`, `min-w-[60px]`) — mostly in `/bookings` and `/distribution` |
| Typography scale | ❌ none beyond Tailwind defaults | **~20 arbitrary text sizes** (`text-[10px]`, `text-[11px]`) used as a 1px-step downsize ladder |
| Borders (radius) | Partial — `rounded-md`, `rounded-lg`, `rounded-full` used consistently | No issues |
| Shadows | ✅ 2 tokens (`shadow-card`, `shadow-elevated`) | `shadow-elevated` is defined but **never used** |
| Motion | ❌ no tokens, but motion barely used | OK to defer |
| Focus | ✅ global `:focus-visible` rule in `globals.css` | No issues — strong baseline |

### What this means in practice

- A designer changing the brand "warning" yellow has to edit `tailwind.config.ts` (token) **and** find every page that wrote `bg-yellow-50`, `text-yellow-900`, `border-yellow-300/400`. Today that's 6 separate files.
- The 1px text-size ladder (`text-[10px]`, `text-[11px]`) suggests we've hit the limit of Tailwind's default scale and need to extend it rather than work around it. Same story for the pixel widths.

---

## Component completeness

| Component | Defined where | Variants | States | Docs | Score | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `btn-primary` | `globals.css` | ✅ | ⚠️ default + hover only — no `:disabled`, no loading | ❌ | 5/10 | Used everywhere; disabled state defined ad-hoc per-page |
| `btn-secondary` | `globals.css` | ✅ | ⚠️ same gap | ❌ | 5/10 |  |
| `btn-danger` | `globals.css` | ✅ | ⚠️ same gap | ❌ | 5/10 | Has 2 visual versions — `globals.css` one (white bg, red text) and the integration page's red destruction zone (raw `border-red-200`). Pick one. |
| `card` | `globals.css` | ❌ no `card-warning`, `card-danger` variants | ✅ | ❌ | 6/10 | "Warning cards" (yellow simulate-status / demo-controls panels) are recreated ad-hoc with raw colours every time |
| `stat` | `globals.css` | ❌ | ❌ | ❌ | **3/10** | **Highest priority fix.** 5 separate components implement this concept — `Stat`, `StatCard`, `StatCardLink`, `StatLink`, `MetricCard` |
| `input` | `globals.css` | ✅ | ✅ default + focus | ⚠️ no error state | ❌ | 6/10 | Error styling done ad-hoc by colouring labels red |
| `label` | `globals.css` | ✅ | — | ❌ | 7/10 |  |
| `help` | `globals.css` | ✅ | — | ❌ | 7/10 |  |
| `badge-*` (5 tones) | `globals.css` | ✅ | — | ❌ | 8/10 | Cleanest part of the system. After the new `status-labels.ts` helper, badges are consistent across the app. |
| `Field` form wrapper | ad-hoc per page | — | — | ❌ | 3/10 | Reimplemented in `/partners/[id]`, `/partners/[id]/edit`, `/fees`, `/users` |
| `Section` (titled card) | ad-hoc per page | — | — | ❌ | 3/10 | Reimplemented at least 4 times |
| `KV` (key/value row) | ad-hoc per page | — | — | ❌ | 3/10 | Reimplemented 3+ times |
| Status filter chip | inline in `/bookings` | — | ✅ active state | ❌ | 5/10 | New, well-built — but not extracted |
| Table | inline in 8 pages | — | — | ❌ | 4/10 | Every page recreates `<thead>`/`<th>` styling. Common patterns: `text-xs uppercase tracking-wide text-ink-subtle bg-surface-muted/40` |
| Empty state | inline in 11 pages | — | — | ❌ | 3/10 | All variants of `<p className="px-6 py-12 text-center text-sm text-ink-muted">…</p>`. Drift across `px-5 py-8`, `px-6 py-12`, etc. |

---

## Naming inconsistencies

| Issue | Where | Recommendation |
| --- | --- | --- |
| Five "stat card" components | `Stat` (in `/rules` and `routing-trace.tsx`), `StatCard` (deleted in `/page.tsx`), `StatCardLink` (`/page.tsx`), `StatLink` (`/distribution/page.tsx`), `MetricCard` (`/partners/[id]/page.tsx`) | One `StatCard` with `as` / `href` prop and `tone` variant |
| `card bg-warning/40` vs `card bg-warning/60` vs `card bg-warning` | `/distribution`, `/transits/[id]`, `/partners/[id]` | Single `card-warning` variant with locked opacity |
| `border-yellow-300` vs `border-yellow-400` for warning panels | `/distribution` line 248 (300), `/transits/[id]` line 227 (400), `/partners/[id]` line 218 (400) | One `warning-border` token, applied via `card-warning` |
| `border-red-200` (integration disconnect) vs `border-red-300` (`.btn-danger`) | `/partners/[id]/integration`, `globals.css` | One `danger-border` token |
| `bg-info/30 border-blue-200` vs `bg-info/40` vs `bg-info` | `/transits/[id]/page.tsx` line 368, `/distribution`, badge usages | Single `card-info` variant |
| Test-styled "warning" `bg-yellow-50 ... border-amber-500` | `/partners/[id]/integration` (the "save these credentials" panel) | Should be `card-warning` or new `card-callout` |
| `text-yellow-900` for body copy inside warning cards | 3 occurrences in `/distribution`, `/partners/[id]`, `/transits/[id]` | Add `text-warning-fg` mapping or accept `text-ink` inside warning cards |

---

## Unconverted pages (Tailwind drift)

Two pages predate the Tailwind conversion and still use inline `style={{}}` with hardcoded hex:

| Page | Inline `style` count | Hardcoded hex count |
| --- | --- | --- |
| `/fees` (`src/app/fees/page.tsx`) | 50+ | ~15 (`#0f172a`, `#64748b`, `#dcfce7`, `#166534`, `#f1f5f9`, `#475569`, `#cbd5e1`, `#e2e8f0`) |
| `/partners/new` (`src/app/partners/new/page.tsx`) | 30+ | ~8 (`#0f172a`, `#64748b`, `#cbd5e1`) |

A smaller leak exists in `/rules` and `/distribution` (one or two inline styles each — likely intentional for dynamic values, but worth a second look).

This isn't just visual inconsistency. It means rebrand work (changing the accent colour, for instance) requires hand-editing these files even though `tailwind.config.ts` defines the token. PRE-LAUNCH task #49 listed these as converted; they aren't.

---

## Accessibility findings

- ✅ Global `:focus-visible` rule using `outline-accent` covers every interactive element — strong baseline.
- ⚠️ Status badges don't carry a non-colour signal. A red-green-colour-blind user can't distinguish `badge-success` (light green) from `badge-warning` (light yellow). Mitigated partially by the friendly label text inside them.
- ⚠️ Tap-to-call `<a href="tel:…">` driver phone links on `/bookings` are not visually distinguishable from the surrounding text on mobile.
- ⚠️ Tables don't have explicit `<caption>` elements — screen readers announce a featureless grid.
- ⚠️ Several `<th>` cells include no `scope="col"`.
- ⚠️ Form fields use `<label>` correctly via the `Field` component, but the inline form helpers in `/fees` and `/partners/new` use loose `<span>` siblings instead. Tab order is fine but screen readers don't associate them.
- ⚠️ The kill-switch button on the dashboard is a destructive irreversible action with no confirmation step. Consider a typed confirmation pattern.
- ⚠️ The UK SVG map has `role="img"` and `aria-label` (good) but the individual fleet rings have `<title>` elements that aren't surfaced to screen readers without a `<desc>`.

---

## Priority actions

Ranked by leverage. Effort estimates assume Mykola with a Derek redline review.

### P1 — High leverage, low effort

1. **Consolidate the 5 stat cards into one `StatCard` component.** 2 days. Eliminates the most visible inconsistency. Define `as` (div/link), `tone` (info/success/danger/warning/neutral), `label`, `value`, `sub`, `accent` (left-border colour). Replace every existing usage in one PR.
2. **Add card variants: `card-warning`, `card-success`, `card-danger`, `card-info`, `card-callout`.** 1 day. Defines the yellow / red / blue panels we keep recreating with raw palette colours. Add matching border tokens.
3. **Extract `EmptyState` component.** 0.5 days. Replaces the 11 ad-hoc `<p className="px-6 py-12 text-center …">` blocks. Single `<EmptyState title="…" body="…" action={…} />`.
4. **Extract `DataTable` head wrapper** (`<TableHeader>` and `<TableHeaderCell>`). 1 day. Locks in the `text-xs uppercase tracking-wide text-ink-subtle bg-surface-muted/40` pattern across the 8 tables.
5. **Extract `Field`, `Section`, `KV` into `src/components/ui/`.** 1 day. They already exist in 3–4 copies; just centralise.

### P2 — Medium leverage, medium effort

6. **Finish Tailwind conversion on `/fees` and `/partners/new`.** 2 days. Mykola converts, Derek redlines. Use this as the opportunity to dogfood the new `Field`, `Section`, `KV` components from #5.
7. **Add `text-2xs` (10px) and `text-3xs` (8px) to the type scale.** 0.5 days. Eliminates ~20 arbitrary `text-[10px]` / `text-[11px]` usages.
8. **Add `min-w` / `max-w` named widths to spacing scale.** 0.5 days. `w-icon`, `w-avatar`, `w-status-col`, `w-time-col`. Eliminates the `w-[140px]` / `w-[160px]` chain.
9. **Add a `loading` state to `.btn-*`.** 0.5 days. With a spinner — used by every server-action form to give feedback during the post.
10. **Add an `error` state to `.input`.** 0.5 days. Red border + describedby pointing at the help text. Needed for form validation.

### P3 — Lower leverage but worth doing

11. **Define a real motion token set** if/when we add transitions beyond `transition-colors`. Currently overkill.
12. **Add `<caption>` and `scope` attributes to every table.** 0.5 days. A11y polish.
13. **Add a non-colour signal to status badges** — a tiny icon or dot. Helps colour-blind users.
14. **Confirmation dialog component** for destructive actions (kill switch, partner suspend, integration disconnect).

### Out of scope for go-live

- Dark mode. Would be a 1-week project on its own; not material to pilot success.
- Storybook or live component playground. Recommended in P2 of the readiness plan but not a launch blocker.
- Visual regression testing (Chromatic / Percy). Recommended post-pilot.

---

## Suggested implementation order (for the GO_PLAN)

This audit slots into the existing Go-Plan as **Sprint 7 design polish work** (the sprint that already has Derek pairing with Mykola on the partner-side dashboard). Two days of that sprint should go to design-system consolidation:

- **Sprint 7 day 1**: Items 1–3 (stat cards, card variants, empty state)
- **Sprint 7 day 2**: Items 4–5 (table header, extracted field/section/KV)

Items 6–10 land opportunistically as Mykola touches affected pages during Sprints 8–10. Items 11–14 are post-launch.

---

## Files referenced

- `src/app/globals.css` — current component definitions
- `tailwind.config.ts` — token definitions
- `src/app/fees/page.tsx`, `src/app/partners/new/page.tsx` — unconverted
- `src/app/page.tsx`, `src/app/distribution/page.tsx`, `src/app/partners/[id]/page.tsx`, `src/app/rules/page.tsx`, `src/components/routing-trace.tsx` — five stat-card variants
- `src/app/bookings/page.tsx` — arbitrary width and text-size offender

---

## Score breakdown

| Dimension | Score | Notes |
| --- | --- | --- |
| Token coverage | 6/10 | Semantic colours present; spacing + typography missing |
| Component completeness | 5/10 | Primitives defined; composite patterns ad-hoc |
| Naming consistency | 4/10 | 5 stat variants + 3 warning-card variants |
| Tailwind conversion completeness | 5/10 | 2 pages still inline-styled |
| Accessibility | 7/10 | Strong focus baseline; tables and forms have polish gaps |
| Documentation | 2/10 | No component docs anywhere — this audit is the first written record |
| Drift resistance (will it stay consistent?) | 5/10 | Each new page recreates patterns rather than reaching for shared components |
| **Overall** | **62/100** | Solid foundation, drift visible, fixable in 5–7 focused days |

---

*Next step: PO sign-off on which P1 items get committed to Sprint 7. Derek to spike the new `StatCard` API in a draft PR before the sprint starts so the spec is unambiguous when Mykola picks it up.*
