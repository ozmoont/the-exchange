## What changed

<!-- One sentence. Why this PR exists. -->

## Spec

<!-- Link to docs/specs/<slug>.md (written by Franko). If no spec, explain why. -->

## Implementation notes

<!-- Anything a reviewer needs to know that isn't obvious from the diff. -->

## QA (Miro) — must be fully ticked before merge

- [ ] `docs/TEST_STRATEGY.md` updated with the new surface
- [ ] Tests added under the correct path (`src/lib/__tests__/`, `src/components/**/__tests__/`, `src/app/api/__tests__/`)
- [ ] `pnpm test:run` is green
- [ ] Regression check completed — adjacent features confirmed unbroken (list what you checked)
- [ ] No `any`, `// @ts-ignore`, or unused exports added

## DevOps (Eamon) — tick if applicable

- [ ] New env var? Updated `.env.example` and the relevant CI step
- [ ] New migration? Rollback plan in this PR description
- [ ] No real secrets committed (JWT shapes, `sk_live_*`, `whsec_*`, keyfiles, DATABASE_URL with credentials)

## Design (Derek) — tick if UI changes

- [ ] Manually reviewed in browser (desktop + one mobile breakpoint)
- [ ] Uses existing design tokens / patterns (no raw hex, no freelance spacing values)
- [ ] Empty state designed (not just a blank list with a CTA)

## Copy (Vicki) — tick if customer-facing words changed

- [ ] Specific, not generic (numbers and real outcomes)
- [ ] No marketing jargon ("unlock", "leverage", "revolutionary")
- [ ] Honest about what the feature does, not what we wish it did
