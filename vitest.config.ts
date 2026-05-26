import { defineConfig } from 'vitest/config'

// Test runner config. Tests live next to the code they cover under a
// __tests__/ directory or as *.test.ts siblings. The backend tests
// rely on env defaults supplied here so we don't need to maintain a
// .env.test file.

export default defineConfig({
  test: {
    environment: 'node',
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
    env: {
      // Required by server/env.ts. Tests don't actually call plex.tv
      // or Sonarr — those are mocked — but the validator runs at
      // import time so it needs *something* present.
      PLEX_CLIENT_ID: '00000000-0000-4000-a000-000000000000',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      SONARR_API_KEY: 'test-sonarr-key',
      RADARR_API_KEY: 'test-radarr-key',
      SAB_API_KEY: 'test-sab-key',
      ADMINS: 'admin-user',
      MIN_FREE_GB: '100',
      STREAM_TOKEN_SECRET: 'stream-token-secret-test-placeholder-xxxxxxxxx',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'server/**/*.ts',
        'src/lib/api/errors.ts',
      ],
      exclude: [
        'server/index.ts', // entry point — only thing it does is `serve()`
        '**/*.test.ts',
      ],
    },
  },
})
