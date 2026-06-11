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
      // (audit 9-5 / 17-7). RATCHET POLICY: floors sit just below (≤1pt under)
      // the numbers measured on the tree they were set against, so the gate
      // bites on a real regression without flaking on a small refactor. Raise
      // every block as tests land; NEVER lower a floor — a drop below any
      // floor means coverage genuinely regressed and the fix is more tests,
      // not a lower bar.
      //
      // Last re-measured 2026-06-11 on the fix-wave-3 merged tree
      // (fix3/spa + fix3/server), `npx vitest run --coverage`:
      //   global    65.52 stmts / 54.82 branches / 53.90 fns / 67.78 lines
      //   server/** 87.89 stmts / 78.00 branches / 87.05 fns / 90.98 lines
      //   src/**    25.86 stmts / 22.62 branches / 21.62 fns / 26.90 lines
      // The prior global floors (20/35/20/20) and src floors were token-level
      // relative to those numbers and gated nothing — ratcheted to just-below-
      // measured across all three blocks.
      thresholds: {
        // Global floor (server + SPA combined).
        statements: 65,
        branches: 54,
        functions: 53,
        lines: 67,
        // Server data plane — held to a high floor so backend coverage cannot
        // silently regress even as the SPA average drags the global down.
        'server/**/*.ts': {
          statements: 87,
          branches: 77,
          functions: 86,
          lines: 90,
        },
        // SPA — ratcheted as the mounted-DOM hook/player suites landed
        // (useSuggestionStrip/useUserApiKey/MediaPlayer *.dom.test.tsx).
        'src/**/*.{ts,tsx}': {
          statements: 25,
          branches: 22,
          functions: 21,
          lines: 26,
        },
      },
    },
  },
})
