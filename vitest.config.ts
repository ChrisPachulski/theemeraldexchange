import { defineConfig } from 'vitest/config'
import { TEST_ENV } from './vitest.env'

// Test runner config. Tests live next to the code they cover under a
// __tests__/ directory or as *.test.ts siblings. The backend tests
// rely on env defaults supplied here so we don't need to maintain a
// .env.test file.

export default defineConfig({
  test: {
    environment: 'node',
    // Per-worker DB isolation (server.db / media.db / iptv.db). vitest runs test
    // files in parallel workers; files that don't set their own *_DB_PATH shared
    // ./data/*.db and raced the sqlite migrator (intermittent `UNIQUE constraint
    // failed: schema_migrations.version` → spurious 500s, e.g. radarr.test.ts
    // under IPTV_DISABLED). See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'server/**/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
    // The recommendation eval harness has its own config (vitest.eval.config.ts)
    // and writes to disk — keep it out of the normal `npm test` run.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'server/routes/suggestions.eval.test.ts',
    ],
    // Required by server/env.ts (validated at import time). Shared with the
    // eval-harness runner via vitest.env.ts so the two can't drift.
    env: TEST_ENV,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Measure the server data plane AND the SPA logic/data layer (audit
      // 17-7). The SPA was previously unmeasured except one file; the mock-only
      // Playwright suite (audit 9-6) does not cover client<->server integration,
      // so expanding include here is the honest choice. WebGL/atmosphere visual
      // effects and the SPA entrypoint are excluded — they are not logic worth
      // gating.
      include: [
        'server/**/*.ts',
        'src/**/*.{ts,tsx}',
      ],
      exclude: [
        'server/index.ts', // entry point — only thing it does is `serve()`
        '**/*.test.ts',
        '**/*.test.tsx',
        'src/components/atmosphere/**',
        'src/lib/gemScene.ts', // Three.js/WebGL brand mark — visual, not logic
        'src/main.tsx', // SPA bootstrap
        'src/vite-env.d.ts',
      ],
      // Thresholds make the gate FAIL on regression instead of only reporting
      // (audit 9-5 / 17-7). The server data plane alone measures ~74% stmts /
      // 63% branches / 75% fns / 78% lines and is well-tested; broadening the
      // include to the (thin, largely untested) SPA pulls the GLOBAL averages
      // down hard, so the global floors are set conservatively below the
      // broadened measured numbers and ratchet upward as the SPA hook/player
      // tests (audit 17-8) land. The point is a gate that bites on a real
      // regression without breaking the current green build. Two scoped blocks
      // keep the well-tested server held to a high floor while the SPA starts
      // low; raise both over time.
      // The regression gate's teeth are the per-glob `server/**` floor (the
      // well-tested surface, ~74-78%). The combined global floor is deliberately
      // low because the broadened SPA include drags the average down until the
      // 17-8 hook/player tests land — a low global floor still fails a real
      // catastrophic regression while never breaking the current green build.
      // Ratchet all three blocks upward over time.
      thresholds: {
        // Global floor (server + SPA combined) — intentionally low; ratchet up.
        statements: 20,
        branches: 35,
        functions: 20,
        lines: 20,
        // Server data plane — held to a high floor so backend coverage cannot
        // silently regress even as the SPA average drags the global down.
        'server/**/*.ts': {
          statements: 65,
          branches: 55,
          functions: 65,
          lines: 65,
        },
        // SPA — ratcheted as the mounted-DOM player/modal suites landed
        // (MediaPlayer/IptvPlayer/EpisodePicker *.dom.test.tsx). Floors sit
        // just below the measured numbers (stmts 22.2% / branches 19.0% /
        // fns 18.1% / lines 23.1%) so the gate bites on a real regression
        // without flaking on a small refactor. Keep raising as SPA tests
        // come in; never lower.
        'src/**/*.{ts,tsx}': {
          statements: 21,
          branches: 17,
          functions: 17,
          lines: 22,
        },
      },
    },
  },
})
