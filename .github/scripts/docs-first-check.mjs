#!/usr/bin/env node
// Flags PRs that introduce known-deprecated Next.js patterns:
//   - unawaited cookies() / headers()
//   - non-Promise route `params` / `searchParams`
//
// Points the author at the relevant shipped doc in node_modules/next/dist/docs/.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const base = process.env.GITHUB_BASE_REF || "main";
let diff = [];
try {
  diff = execSync(`git diff --name-only origin/${base}...HEAD`, {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
} catch {
  // Local run / no origin available — fall back to all tracked files
  try {
    diff = execSync("git ls-files src/", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    diff = [];
  }
}

const tsFiles = diff.filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f));
const violations = [];

for (const file of tsFiles) {
  const src = readFileSync(file, "utf8");

  // Unawaited cookies() / headers()
  const cookiesPattern = /(?<!await\s)(?<![.\w])cookies\(\)/g;
  const headersPattern = /(?<!await\s)(?<![.\w])headers\(\)/g;

  if (cookiesPattern.test(src)) {
    violations.push({
      file,
      issue: "Unawaited cookies()",
      doc: "node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.mdx",
    });
  }
  if (headersPattern.test(src)) {
    violations.push({
      file,
      issue: "Unawaited headers()",
      doc: "node_modules/next/dist/docs/01-app/03-api-reference/04-functions/headers.mdx",
    });
  }

  // Non-Promise params / searchParams in page/layout/route signatures
  const syncParams =
    /\b(params|searchParams)\s*:\s*\{[^}]+\}(?!\s*\|\s*Promise)/g;
  if (syncParams.test(src) && /\/(page|layout|route)\.(ts|tsx)$/.test(file)) {
    violations.push({
      file,
      issue: "Non-Promise params/searchParams in page/layout/route",
      doc: "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.mdx",
    });
  }
}

if (violations.length) {
  console.error("\n[X] docs-first check failed\n");
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    issue: ${v.issue}`);
    console.error(`    fix:   read ${v.doc}\n`);
  }
  console.error(
    "Training data on Next.js is wrong. Read the shipped docs in node_modules/next/dist/docs/ before fixing.\n"
  );
  process.exit(1);
}

console.log(`docs-first check passed (${tsFiles.length} files scanned)`);
