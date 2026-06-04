/**
 * Vitest setup — runs before any test module is loaded. Sets the env vars
 * that `src/db/client.ts` and friends assert on at import time, so unit
 * tests that touch a module which transitively imports the DB client can
 * import without crashing.
 *
 * Tests that actually need to talk to a database run as integration tests
 * (currently none — adapter tests stub the DB, fees tests stub query
 * helpers). If we ever add a real-DB integration test, override the env
 * var in that test's `beforeAll`.
 */

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AUTH_SECRET ??= "test-auth-secret-not-used-anywhere-real";
process.env.PARTNER_CREDENTIAL_KEY ??= Buffer.alloc(32, 0xab).toString("base64");
process.env.APP_URL ??= "http://localhost:3000";
