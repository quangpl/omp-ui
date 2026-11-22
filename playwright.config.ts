import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  BASE_URL,
  E2E_DATA_DIR,
  FAKE_OMP_LOG,
  FAKE_OMP_PATH,
  PORT,
  REPO_ROOT,
  WORKSPACE_DIR,
} from "./e2e/helpers";

// Browser e2e against the production build (`pnpm build` first). Agents run the deterministic
// fake omp, so no real omp, model or network is involved.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      // Pixel 7 is Chromium-based: touch + mobile viewport without needing WebKit.
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    // webServer starts before globalSetup, so the data dir is reset right here.
    command: "rm -rf .e2e-data && mkdir -p .e2e-data/ws .e2e-data/fake-omp && node dist/standalone/server.js",
    cwd: REPO_ROOT,
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      DATA_DIR: E2E_DATA_DIR,
      // Empty → SQLite in DATA_DIR even if the developer's shell points at another database.
      DATABASE_URL: "",
      AUTH_SECRET: "",
      WORKSPACE_DIR,
      OMP_PATH: FAKE_OMP_PATH,
      OMP_EXTRA_ARGS: "",
      ADMIN_PASSWORD,
      FAKE_OMP_SCENARIO: "success",
      FAKE_OMP_LOG,
      FAKE_OMP_SESSION_DIR: path.join(E2E_DATA_DIR, "fake-omp"),
    },
  },
});
