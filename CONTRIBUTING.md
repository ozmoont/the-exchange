# Contributing to The Exchange

Welcome. This doc gets a new contributor productive on the first day and
keeps the team in sync as the project grows. It's the rulebook for how
work moves through the repo.

If a rule below doesn't match what the repo actually does, the repo wins
— fix this file and open a PR with the correction.

---

## Day-one setup

You should be invited to three places before you start:

- **GitHub** — `https://github.com/ozmoont/the-exchange` (Triage or Write
  access). Accept the invite from your inbox.
- **Vercel** — the `ozmoont` team, Developer role by default. You'll see
  deploys and logs; env-vars are gated behind a higher role.
- **Neon** — the `the-exchange` Postgres project. Read access lets you
  inspect data; Editor lets you run migrations against the shared dev DB.

Once those are accepted:

```bash
git clone https://github.com/ozmoont/the-exchange.git
cd the-exchange
pnpm install
cp .env.example .env.local   # ask OG for filled-in values
pnpm typecheck
pnpm test:run
```

For local development against the dev DB:

```bash
pnpm dev
```

That starts Next.js on `http://localhost:3000` against the connected
Neon branch.

If you're running a local Postgres, set `DATABASE_URL` to it and run
`pnpm db:migrate` first to apply the drizzle migrations.

---

## Project shape

Required reading before touching code, in order:

1. `docs/PROJECT_OVERVIEW.md` — what this is and how the pieces fit.
2. `docs/STRATEGY.md` — locked decisions. Don't relitigate without a
   spec.
3. `docs/specs/` — per-feature acceptance criteria (Franko's lane).
4. `docs/TEST_STRATEGY.md` — what's covered, where tests live, and what
   layer to add new ones at.
5. `docs/RUNBOOK.md` — what to do when things break in prod.

There are ~25 docs total — skim `docs/INTEGRATION_GUIDE.md` and
`docs/CANONICAL_FIELDS.md` for the partner-facing surface, then dip into
the rest as needed.

---

## Workflow

### Branches

`main` is protected. All work goes through PRs.

Branch naming: `<role>/<short-slug>`. Examples:

- `feature/cmac-quote-fare`
- `fix/webhook-token-edge-case`
- `chore/upgrade-drizzle`
- `docs/contributing-guide`

Keep branches short-lived (target: merge within a day). Stale branches
collect conflicts.

### Spec → code → tests → PR

For anything bigger than a trivial fix:

1. **Spec exists.** Find or write `docs/specs/<slug>.md`. The spec
   states the user-facing change, acceptance criteria, and any
   architectural decisions. PRs without a spec link must explain why.
2. **Implement.** Match the spec. If reality forces a deviation,
   update the spec in the same PR.
3. **Tests.** Add them at the layer `docs/TEST_STRATEGY.md` prescribes
   (unit / component / api / smoke). Don't skip this.
4. **Open the PR.** Fill in every section of the PR template. CI runs
   typecheck + vitest + docs-first.

### PR template

The repo's `.github/pull_request_template.md` pre-fills a structured
description with checklist sections for QA, DevOps, Design, and Copy.
Tick what applies. If a section doesn't apply (e.g. no UI changes),
say so explicitly in a comment — don't just leave it empty.

### Reviews

- **One required approval** before merge — from someone who didn't
  write the code.
- **QA reviews every feature PR** before merge. Add the designated
  reviewer when you open. They'll tick the QA checklist and sign off,
  or push back with regression concerns.
- **Squash-merge** unless the branch genuinely has independently
  meaningful commits.

---

## CI gates

Three workflows run on every PR. All must pass before merge.

### `ci.yml`

- **typecheck** — `pnpm typecheck` (strict mode, no `any`, no
  `@ts-ignore`)
- **test** — `pnpm test:run` (vitest)

Both run on Node 22 + pnpm 9 with frozen lockfile. If the lockfile is
out of date the install fails.

### `docs-first.yml`

Catches the deprecated Next.js patterns that keep biting us in App
Router code:

- Unawaited `cookies()` / `headers()` — must be `await cookies()`
- Sync `params` / `searchParams` in page/layout/route — must be
  `Promise<{...}>`

If this fails, the error message points you to the relevant Next.js
doc shipped in `node_modules/next/dist/docs/`. Fix and push again.

The script itself is `.github/scripts/docs-first-check.mjs`.

---

## Common pitfalls

- **Don't commit real secrets.** Search the diff for `sk_live_`,
  `whsec_`, full `DATABASE_URL`s with credentials, JWTs, App-Key /
  Secret-Key pairs. `git-secrets` or a manual scan before push works.
- **Don't add `any` or `// @ts-ignore`.** The codebase is strict on
  purpose. If you need a type escape hatch, use `// @ts-expect-error`
  with a one-line explanation so it surfaces if the underlying type
  improves.
- **Don't write new migrations by hand.** Use
  `pnpm db:generate` against the schema change, then
  `pnpm db:migrate`. The migration runner stays idempotent that way.
- **Don't reuse credentials across partner rows.** Every iCabbi
  tenant gets its own App-Key + Secret-Key + webhook secret. AES at
  rest is keyed by `PARTNER_CREDENTIAL_KEY` — rotating it breaks
  every existing partner row.
- **Don't bypass auth for "just this test".** `DISABLE_AUTH=true` is
  a development escape hatch only. Production must have it off.
- **Don't put partner-specific code in shared paths.** The H2 mapping
  engine (`src/lib/mapping-layer.ts` + `src/adapters/generic-mapped.ts`)
  is config-driven on purpose. New external aggregator partners go
  through `partners.fieldMappings` JSONB, not a hand-coded adapter.
  See `docs/CMAC_INTEGRATION.md` for the worked example.

---

## Local commands you'll actually use

| Command                              | What it does                                     |
|--------------------------------------|--------------------------------------------------|
| `pnpm dev`                           | Next.js dev server                               |
| `pnpm typecheck`                     | TS strict check, no emit                         |
| `pnpm test:run`                      | Vitest one-shot                                  |
| `pnpm test`                          | Vitest watch mode                                |
| `pnpm db:generate`                   | Diff schema → drizzle migration                  |
| `pnpm db:migrate`                    | Apply pending migrations                         |
| `pnpm seed`                          | Seed local DB with demo data                     |
| `pnpm seed:icabbi-staging`           | Seed the iCabbi staging test partners            |
| `pnpm seed:cmac-test`                | Seed the CMAC test partner                       |
| `pnpm smoke:cmac`                    | Adapter-direct CMAC API smoke (laptop only)      |
| `pnpm smoke:icabbi-staging`          | End-to-end iCabbi staging smoke                  |

---

## Questions

- **Code unclear?** Open a GitHub Issue or DM in the project channel.
- **Spec unclear?** Tag Franko on the spec doc.
- **Test strategy unclear?** Tag the QA reviewer on the PR.
- **Prod incident?** `docs/RUNBOOK.md` first, then page OG.
- **Doc out of date?** Fix it. Docs are part of the codebase.
