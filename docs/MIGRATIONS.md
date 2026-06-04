# Migrations

We use **versioned drizzle migrations** for prod schema changes, not `drizzle-kit push`.

Why: `push` diffs the live schema against the TypeScript schema and applies whatever ALTERs it thinks are needed. Under strict mode it can silently drop columns. It also runs the whole migration as one transaction with no incremental control. Versioned migrations are reviewable, replayable, and tracked.

`push` is still useful for **local dev** when you want to bang on the schema without worrying about migration noise. Don't use it on prod.

---

## The workflow

### 1. Edit the schema

`src/db/schema.ts` is the source of truth. Edit it like you'd edit any TypeScript file.

### 2. Generate the migration

```bash
pnpm db:generate
```

drizzle-kit diffs your `schema.ts` against the previously-generated state (snapshot under `drizzle/meta/`) and writes a new file:

```
drizzle/0001_<random-name>.sql
drizzle/meta/0001_snapshot.json
```

You'll be prompted to confirm any potentially-destructive changes (drops, renames). Take a look at the generated SQL — drizzle's renames especially can be over-eager.

### 3. Review the SQL

Open the new `drizzle/000X_*.sql` file. Sanity-check:

- New columns set sensible defaults
- No accidental drops
- Indices are added where you expect

### 4. Commit + deploy

```bash
git add drizzle/
git commit -m "feat: <describe the schema change>"
git push
```

Vercel auto-deploys. The build command is:

```json
"buildCommand": "pnpm db:migrate && pnpm build"
```

`pnpm db:migrate` runs `src/scripts/migrate.ts`, which applies every migration in `drizzle/` that hasn't been applied yet. Already-applied migrations are skipped (tracked in `__drizzle_migrations` on prod).

If `db:migrate` fails, **the build fails** — no broken deploy lands.

---

## Local development

If you're using Docker Postgres for local dev, the same migrations apply:

```bash
pnpm db:migrate
```

For quick iteration (e.g. trying a column shape before locking it in), `pnpm db:push` is still available — it's just for local dev convenience and shouldn't be used against prod.

---

## One-time baseline mark for existing prod

If you're rolling this out against a prod DB that was previously managed via `db:push`, the migrations folder is currently empty. The first `pnpm db:generate` will produce a baseline migration containing the entire current schema. **You don't want this baseline to actually run against prod** — it would error on every CREATE TABLE because the tables already exist.

To handle this, after generating the baseline:

```bash
# 1. Generate the baseline migration
pnpm db:generate

# 2. Inspect the SQL — confirm it's the full schema
cat drizzle/0000_*.sql

# 3. Tell prod the baseline is "already applied" — we don't actually run
#    its SQL; we just record it in __drizzle_migrations.
DATABASE_URL='<prod>' pnpm exec tsx scripts/mark-migration-applied.ts drizzle/0000_<filename>.sql
```

(Helper script for that one-time mark step is at `scripts/mark-migration-applied.ts` once needed.)

From that point on, every subsequent migration runs normally.

---

## Failure modes

| Scenario | What happens |
| --- | --- |
| Migration SQL has a syntax error | Build fails. Fix the .sql file, commit, deploy. |
| Migration applies partially (mid-run failure) | Postgres rolls back the transaction. Next deploy retries. |
| You forgot to commit the migration file | Build runs the *previous* migration set. New schema features that need the migration will throw at runtime. Commit the file and re-deploy. |
| Two engineers each generate a migration for the same change | Both files commit. drizzle-kit applies them in order — the second one is usually a no-op. Worth catching in review. |
| Long-running migration (>30s) | Vercel build has a timeout. For big migrations, run them outside Vercel via `DRIZZLE_ENV_FILE=.env.production pnpm db:migrate` and then deploy with the migration already applied. |

---

## What `db:migrate` doesn't handle (yet)

- **Down migrations** — drizzle-orm/migrator only goes forward. For rollback, you write a new forward migration that undoes the previous one.
- **Concurrent index creation** — drizzle-kit generates `CREATE INDEX` not `CREATE INDEX CONCURRENTLY`. Edit the generated SQL by hand for large tables.
- **Long-running data migrations** — see above re: Vercel timeout.

When any of these become real problems, we move to a dedicated migration tooling like Atlas or hand-rolled SQL with a deploy pipeline.

---

## When `db:push` is still OK

- Local dev against Docker Postgres
- Spike branches you don't intend to merge
- Demoing schema ideas in a Neon branch

**Never against the main prod database.**
