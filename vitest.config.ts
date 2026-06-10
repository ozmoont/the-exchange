import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      // Coverage is scoped to the unit-testable core: business logic (lib)
      // and partner adapters. UI pages/components and src/scripts are
      // deliberately excluded — per docs/TEST_STRATEGY.md they are covered
      // by the smoke scripts (integration) rather than unit tests, and
      // including them would dilute the number into meaninglessness.
      provider: "v8",
      include: ["src/lib/**", "src/adapters/**"],
      exclude: ["src/**/__tests__/**"],
      // all:true counts every included file, not just those imported by a
      // test — so a future lib/adapter file that ships with no tests drags
      // the number down and trips the gate, instead of being silently
      // omitted from the denominator.
      all: true,
      // Thresholds are a regression gate, not an aspiration: the suite sits
      // at ~99.8% lines / ~92% branches today. A PR that drops the core
      // below these numbers should fail `pnpm vitest run --coverage`.
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 85,
      },
      reportOnFailure: true,
    },
  },
});
