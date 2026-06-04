import type { Config } from "drizzle-kit";

// Inline env vars (DATABASE_URL=... pnpm db:push) take precedence over the
// file. Only load the file when DATABASE_URL is not already set — otherwise
// loadEnvFile would clobber the inline value with whatever the file has.
//
// You can also point at a different file with DRIZZLE_ENV_FILE:
//   DRIZZLE_ENV_FILE=.env.production pnpm db:push
const ENV_FILE = process.env.DRIZZLE_ENV_FILE ?? ".env.local";

if (
  !process.env.DATABASE_URL &&
  typeof (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile === "function"
) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(ENV_FILE);
  } catch {
    // file may not exist — that's fine, we'll error below if DATABASE_URL is still unset
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    `DATABASE_URL is not set. Either put it in ${ENV_FILE}, pass it inline ` +
      `(DATABASE_URL='...' pnpm db:push), or point at a different file with ` +
      `DRIZZLE_ENV_FILE=.env.production pnpm db:push.`,
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
} satisfies Config;
