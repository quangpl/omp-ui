import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit + integration tests (Node). Browser e2e lives in e2e/ and runs with Playwright.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // DB-backed suites share external services; keep files sequential for determinism.
    fileParallelism: false,
    // Card runs must never reach the developer's real agentmemory server (session tagging, auto-start).
    // Suites that never set DATA_DIR must not write event logs (lib/server/log-store.ts) into ./data.
    env: { AGENTMEMORY_ENABLED: "false", DATA_DIR: path.join(os.tmpdir(), "omp-ui-vitest-data") },
  },
});
