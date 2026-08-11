import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Mocks are stubbed per-test; resetting between tests keeps a forgotten
    // `vi.stubGlobal` in one file from leaking into the next.
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // The CLI is an interactive shell around the library; it is exercised by
      // hand, and holding it to the same bar as the money path would only
      // invite tests that assert prompt strings.
      exclude: ["src/cli/**", "src/index.ts", "src/providers/**/index.ts"],
      thresholds: {
        // Global floor, plus a hard bar on the code that decides where money
        // goes. These are the numbers the suite already meets - they exist to
        // stop regressions, not to chase a percentage.
        lines: 70,
        functions: 70,
        "src/payment/**": { lines: 90, functions: 90 },
        "src/qris/**": { lines: 90, functions: 90 },
      },
    },
  },
});
