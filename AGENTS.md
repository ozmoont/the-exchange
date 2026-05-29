<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
This version has breaking changes - APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
CI enforces a subset of this rule via `.github/scripts/docs-first-check.mjs` (the **docs-first** job). PRs that introduce known-deprecated patterns (e.g. unawaited `cookies()`/`headers()`, non-Promise `params`) will fail with a pointer to the relevant shipped doc.
<!-- END:nextjs-agent-rules -->

# Team

Work can be assigned by persona name. Full roster, responsibilities, and
escalation paths live in `TEAM.md` — that's the single source of truth;
don't restate it here.

All seven personas are wired as invocable subagents under
`.claude/agents/` (`andy.md`, `bobby.md`, `mykola.md`, `derek.md`,
`miro.md`, `eamon.md`, `vicki.md`). Each defines its own scope,
standards, and refusal list. Pick the right one for the job rather
than defaulting to "helpful generalist"; if no persona fits, surface
that gap to the founder rather than improvising the role yourself.

# Definition of done — every feature

A feature is not done when the code compiles. It is done when **Miro** has signed off. The flow is:

1. **Andy** writes the spec (problem, scope, acceptance criteria).
2. **Mykola** implements against the spec.
3. **Miro receives the spec** and:
   - Updates `docs/TEST_STRATEGY.md` to cover the new surface (what to test, at which layer).
   - Adds the actual tests under the appropriate paths (`src/lib/__tests__/`, `src/components/**/__tests__/`, `src/app/api/__tests__/`).
   - Runs `npm run test:run` and confirms it is green.
   - Runs a regression check on adjacent features (anything sharing the same route, query, or component tree).
4. The PR cannot be merged until the **QA (Miro)** section of the PR template is fully ticked.

If you are an AI assistant implementing a feature, invoke the **Miro** subagent (`.claude/agents/miro.md`) once the implementation is in place — do not mark the task done yourself.
