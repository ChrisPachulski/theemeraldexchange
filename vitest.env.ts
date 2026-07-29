// Single source of truth for the test-time env both vitest runners inject:
// the default suite (vitest.config.ts) and the AI-recommendation eval harness
// (vitest.eval.config.ts). server/env.ts validates its required vars at IMPORT
// time, so any runner that imports server code must supply them. The eval
// config used to duplicate a subset of this block and silently rotted the day
// STREAM_TOKEN_SECRET became required (`npm run eval:recs` died on import with
// "Missing required env var: STREAM_TOKEN_SECRET"). Keep it in ONE place so the
// next required-var addition can't break a runner that nobody runs in CI.
export const TEST_ENV: Record<string, string> = {
  // Tests don't call plex.tv / Sonarr / Radarr (those are mocked), but the
  // env validator runs at import time so it needs *something* present.
  PLEX_CLIENT_ID: '00000000-0000-4000-a000-000000000000',
  SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
  SONARR_API_KEY: 'test-sonarr-key',
  RADARR_API_KEY: 'test-radarr-key',
  SAB_API_KEY: 'test-sab-key',
  ADMINS: 'admin-user',
  MIN_FREE_GB: '100',
  STREAM_TOKEN_SECRET: 'stream-token-secret-test-placeholder-xxxxxxxxx',
  DEVICE_TOKEN_SECRET: 'device-token-secret-test-placeholder-yyyyyyyyy',
  INTERNAL_PRINCIPAL_SECRET: 'internal-principal-secret-test-placeholder-zzz',
  // Pin SPA serving OFF: unset auto-detects on ./dist/index.html (present on
  // any machine that ever ran a vite build) AND the probe is an fs call at
  // env import time, which trips suites that mock node:fs (iptv.test.ts).
  SERVE_SPA: '0',
}
