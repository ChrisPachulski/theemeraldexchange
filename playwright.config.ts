import { defineConfig, devices } from '@playwright/test'

// Thin browser-smoke layer that sits on top of the ~276 vitest unit tests.
// We start Vite alone (not the full `npm run dev` which also boots the
// Hono backend) because every /api/* call is intercepted via
// page.route() in each spec. Booting a real backend just to mock it
// would be wasted ceremony and would require a populated .env.local.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Single worker locally keeps the shared dev server stable across
  // specs. CI can scale up.
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev:vite',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
