import { existsSync } from 'fs'
import { defineConfig, devices } from '@playwright/test'

// Three e2e tiers:
//
//   1. `chromium` (default, fast) — browser-smoke specs in tests/e2e/*.spec.ts
//      with every /api/* call intercepted via page.route(). Starts Vite only.
//      Run: npm run test:e2e
//
//   2. `integration` (PW_INTEGRATION=1) — REAL client↔server coverage.
//      Boots the actual Hono backend (throwaway sqlite in tmpdir, all
//      upstreams pointed at tests/e2e/helpers/stubUpstreams.ts) plus Vite on
//      a dedicated port pair, and drives real logins/flows with ZERO route
//      mocking. Run: npm run test:e2e:integration
//
//   3. `playback-chrome` (PW_INTEGRATION=1 + real Chrome) — the MSE playback
//      regression gate. MUST run on branded Chrome (channel: 'chrome'):
//      the bundled open-source Chromium ships WITHOUT the proprietary
//      H.264/AAC decoders, so a real-codec HLS fixture "fails" there even
//      when production browsers play it fine (the grey-box class of bug this
//      gate exists for was only reproducible in real Chrome). CI installs it
//      via `npx playwright install chrome`; locally the project is skipped
//      loudly when no Chrome install is found.
//      Run: npm run test:e2e:playback
//
// The integration tiers use ports 3105 (backend) / 3106 (stubs) / 5175
// (Vite) so they can never collide with a developer's running `npm run dev`
// (3001/5173).

const INTEGRATION = process.env.PW_INTEGRATION === '1'
const BACKEND_PORT = 3105
const VITE_PORT = INTEGRATION ? 5175 : 5173

// Real-Chrome discovery for the playback tier. `channel: 'chrome'` resolves
// the branded install at these well-known locations; probing them here lets
// the config drop (and loudly announce) the project instead of failing the
// whole run on machines without Chrome.
const CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
}
const chromeAvailable = (CHROME_PATHS[process.platform] ?? []).some((p) => existsSync(p))
if (INTEGRATION && !chromeAvailable) {
  console.warn(
    '\n[playwright] ⚠ real Chrome not found — the `playback-chrome` MSE gate is SKIPPED.\n' +
      '             Install Google Chrome (CI: `npx playwright install chrome`) to run it.\n',
  )
}

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
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Fast mocked tier — every /api/* call fulfilled via page.route().
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/integration/**', '**/playback/**'],
    },
    ...(INTEGRATION
      ? [
          {
            name: 'integration',
            use: { ...devices['Desktop Chrome'] },
            testDir: 'tests/e2e/integration',
          },
          ...(chromeAvailable
            ? [
                {
                  name: 'playback-chrome',
                  // Branded Chrome for proprietary H.264/AAC — see header.
                  use: { ...devices['Desktop Chrome'], channel: 'chrome' },
                  testDir: 'tests/e2e/playback',
                },
              ]
            : []),
        ]
      : []),
  ],
  webServer: INTEGRATION
    ? [
        {
          // Real Hono backend + upstream stubs. NODE_ENV=test is the hard
          // gate for the helper's test-only login route.
          command: 'npx tsx tests/e2e/helpers/integrationServer.ts',
          url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
          env: { NODE_ENV: 'test' },
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          // Vite on the dedicated port, /api proxied at the real backend
          // (vite.config.ts reads PORT for the proxy target).
          command: `npx vite --port ${VITE_PORT} --strictPort`,
          url: `http://localhost:${VITE_PORT}`,
          env: { PORT: String(BACKEND_PORT) },
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ]
    : {
        // Mocked tier: Vite alone (not the full `npm run dev`, which also
        // boots the Hono backend) because every /api/* call is intercepted
        // via page.route() in each spec.
        command: 'npm run dev:vite',
        url: `http://localhost:${VITE_PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
})
