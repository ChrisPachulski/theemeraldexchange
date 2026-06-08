import { defineConfig } from 'vitest/config'
import { TEST_ENV } from './vitest.env'

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
    // Shared with vitest.config.ts via vitest.env.ts. This block used to be a
    // hand-maintained subset and silently broke when STREAM_TOKEN_SECRET became
    // required by server/env.ts; sharing it stops that drift recurring.
    env: TEST_ENV,
  },
})
