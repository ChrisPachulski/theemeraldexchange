import { defineConfig } from 'vitest/config'

// Test runner config. SPA tests live next to the code they cover as
// *.test.ts(x) siblings; repo-contract tests (Dockerfiles, compose, deploy
// scripts, the license notice) live in tests/contracts, the dev media-core
// mock's own tests in tests/dev. The backend's tests are Rust (cargo test).

export default defineConfig({
  test: {
    environment: 'node',
    // The contract tests shell out to deploy scripts; on a busy machine that
    // can exceed Vitest's 5s default. Keep a finite ceiling with room.
    testTimeout: 10_000,
    // Restore any vi.stubGlobal() after every test, unconditionally. Files that
    // stub globals (fetch, etc.) already unstub in afterEach, but an async leak
    // — a handler touching fetch after the per-file restore, or a throw before
    // teardown — can let a stub escape into another file sharing the worker and
    // surface as a spurious cross-file failure (e.g. a "socket hang up"/599 in an
    // unrelated suite). This closes that class globally.
    unstubGlobals: true,
    // jsdom localStorage shim (see vitest.setup.ts).
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/contracts/**/*.test.ts',
      'tests/dev/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Measure the SPA logic/data layer (audit 17-7); the backend is Rust and
      // gated by cargo test. WebGL/atmosphere visual effects and the SPA
      // entrypoint are excluded — they are not logic worth gating.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
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
      // them as tests land; NEVER lower a floor — a drop below one means
      // coverage genuinely regressed and the fix is more tests, not a lower bar.
      //
      // Re-measured 2026-10-18 when the TS server left the tree (the old
      // global floor averaged server/** in; the SPA-only figure is the new
      // base), `npx vitest run --coverage`:
      //   src/**    62.04 stmts / 55.60 branches / 49.61 fns / 64.82 lines
      // Re-measured 2026-10-18 after the Plex sign-in, Play in Plex and Users
      // tab came back with their tests:
      //   src/**    63.22 stmts / 56.19 branches / 50.67 fns / 65.99 lines
      thresholds: {
        statements: 62,
        branches: 55,
        functions: 50,
        lines: 65,
      },
    },
  },
})
