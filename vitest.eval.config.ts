import { defineConfig } from 'vitest/config'

// Separate vitest config for the AI-recommendation-section eval harness.
// Runs only under `npm run eval:recs` so the regular `npm test` flow
// stays fast and deterministic. The eval suite is order-sensitive: the
// final "writes consolidated report" test depends on the prior scenario
// tests populating the REPORT buffer.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/routes/suggestions.eval.test.ts'],
    sequence: { concurrent: false },
    env: {
      PLEX_CLIENT_ID: '00000000-0000-4000-a000-000000000000',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      SONARR_API_KEY: 'test-sonarr-key',
      RADARR_API_KEY: 'test-radarr-key',
      SAB_API_KEY: 'test-sab-key',
      ADMINS: 'admin-user',
      MIN_FREE_GB: '100',
    },
  },
})
