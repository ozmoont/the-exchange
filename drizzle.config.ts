import type { Config } from "drizzle-kit";

// drizzle-kit doesn't pick up .env.local automatically. Load it manually using
// Node's built-in loadEnvFile (Node 20.12+). Safe no-op if already loaded.
if (typeof (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile === "function") {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(".env.local");
  } catch {
    // file may not exist or already loaded — that's fine
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Put it in .env.local — see .env.example for the Docker default.",
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
} satisfies Config;
