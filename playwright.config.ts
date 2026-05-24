import { defineConfig, devices } from '@playwright/test'

/**
 * Real-stack E2E tests for Accu-Mk1. Drives a real Chromium against the dev
 * frontend at BASE_URL (default http://localhost:3101). Auth uses real
 * credentials from env vars (E2E_EMAIL, E2E_PASSWORD) — see e2e/fixtures/auth.ts.
 *
 * Run:
 *   E2E_EMAIL=admin@accumark.local E2E_PASSWORD=... npm run test:e2e
 *
 * Or for a headed debug run:
 *   E2E_EMAIL=... E2E_PASSWORD=... npm run test:e2e:headed
 *
 * The dev stack (frontend on 3101, backend on 8012, IS via host.docker.internal)
 * must be running before the suite starts — Playwright does not bring it up.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3101'

export default defineConfig({
  testDir: './e2e',
  // Phase 29 specs run quickly individually; serial avoids racing the same
  // login store across workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Real network — no MSW, no fixtures. Everything hits the running stack.
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Artifacts land here; they're gitignored.
  outputDir: 'test-results',
})
