// REAL-backend bootstrap for the e2e integration tier. Launched by
// playwright's webServer (see playwright.config.ts, PW_INTEGRATION=1)
// as: NODE_ENV=test tsx tests/e2e/helpers/integrationServer.ts
//
// What it boots, in order:
//   1. the all-upstreams stub (tests/e2e/helpers/stubUpstreams.ts) on
//      EEX_E2E_STUB_PORT — Radarr/Sonarr/SAB/PMS/transcoder at the HTTP
//      boundary, nothing else faked;
//   2. the REAL Hono app (server/app.ts) on EEX_E2E_BACKEND_PORT with a
//      throwaway sqlite data dir in os.tmpdir() and every upstream URL
//      pointed at the stub;
//   3. a TEST-ONLY login route (/api/test/login) that mints a real
//      session cookie via the same createSession/setSessionCookie path
//      production logins use. There is no passkey/Plex ceremony a
//      headless browser can complete, so this is the sanctioned seam —
//      it lives HERE in the e2e helper layer (never in server/) and the
//      process refuses to boot at all unless NODE_ENV === 'test'.
//
// The Vite dev server (second webServer entry) proxies /api/* here, so
// the browser exercises the same-origin path real dev traffic uses.

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startStubUpstreams } from './stubUpstreams.js'

// ── Hard test-only gate ─────────────────────────────────────────────────
// This process wires a cookie-minting login route with no credential
// check. It must be impossible to boot against anything but the
// throwaway test environment below.
if (process.env.NODE_ENV !== 'test') {
  console.error(
    '[integration-server] refusing to start: NODE_ENV must be "test" ' +
      `(got ${JSON.stringify(process.env.NODE_ENV)}). This entrypoint mints ` +
      'sessions without credentials and exists only for the e2e tier.',
  )
  process.exit(1)
}

const BACKEND_PORT = Number(process.env.EEX_E2E_BACKEND_PORT ?? 3105)
const STUB_PORT = Number(process.env.EEX_E2E_STUB_PORT ?? 3106)
const STUB = `http://127.0.0.1:${STUB_PORT}`

/** The owner-bootstrap sub the integration specs sign in as (admin via
 *  ADMIN_SUBS — no members row needed). Exported for spec parity; keep
 *  in sync with tests/e2e/integration specs' LOGIN constants. */
export const E2E_ADMIN_SUB = 'plex:1900000001'

// ── Environment — set BEFORE importing any server module ──────────────
// server/env.ts validates at import time and dotenv only fills UNSET
// vars, so everything that matters is pinned here explicitly (a stray
// developer .env.local must not leak a real TMDB key or Xtream host
// into the integration run).
const dataDir = mkdtempSync(join(tmpdir(), 'eex-e2e-'))
const pin = (k: string, v: string) => {
  process.env[k] = v
}
pin('PORT', String(BACKEND_PORT))
// Same baseline secrets the vitest suites use (vitest.env.ts values,
// inlined because this file runs under tsx, not vitest).
pin('PLEX_CLIENT_ID', '00000000-0000-4000-a000-000000000000')
pin('SESSION_SECRET', 'test-secret-test-secret-test-secret-test-secret')
pin('STREAM_TOKEN_SECRET', 'stream-token-secret-test-placeholder-xxxxxxxxx')
pin('DEVICE_TOKEN_SECRET', 'device-token-secret-test-placeholder-yyyyyyyyy')
pin('INTERNAL_PRINCIPAL_SECRET', 'internal-principal-secret-test-placeholder-zzz')
pin('SONARR_API_KEY', 'test-sonarr-key')
pin('RADARR_API_KEY', 'test-radarr-key')
pin('SAB_API_KEY', 'test-sab-key')
pin('ADMINS', 'admin-user')
pin('ADMIN_SUBS', E2E_ADMIN_SUB)
pin('MIN_FREE_GB', '100')
// Throwaway sqlite + JSONL data, wiped with the tmpdir.
pin('SERVER_DB_PATH', join(dataDir, 'server.db'))
pin('IPTV_DB_PATH', join(dataDir, 'iptv.db'))
pin('MEDIA_DB_PATH', join(dataDir, 'media.db'))
pin('RECOMMENDER_DB_PATH', join(dataDir, 'exchange.db'))
pin('REJECTIONS_PATH', join(dataDir, 'rejections.json'))
pin('USER_FEEDBACK_PATH', join(dataDir, 'user-feedback.json'))
pin('USAGE_LOG_PATH', join(dataDir, 'usage.jsonl'))
pin('GRAB_LOG_PATH', join(dataDir, 'grabs.jsonl'))
pin('DB_BACKUP_DIR', join(dataDir, 'backups'))
// Every upstream → the stub. PMS deep-link probes included.
pin('SONARR_URL', `${STUB}/sonarr`)
pin('RADARR_URL', `${STUB}/radarr`)
pin('SAB_URL', `${STUB}/sab`)
pin('PLEX_SERVER_URL', `${STUB}/plex`)
pin('MEDIA_CORE_URL', `${STUB}/media-core`)
pin('MEDIA_TRANSCODER_URL', `${STUB}/transcoder`)
// /api/transcode (the playback spec's proxy path) only mounts with
// media-core enabled.
pin('USE_MEDIA_CORE', '1')
// Deterministic suggestion fallback: no TMDB key, no local recommender,
// no IPTV upstream, no telemetry. opt() treats '' as unset.
pin('TMDB_API_KEY', '')
pin('TMDB_READ_ACCESS_TOKEN', '')
pin('USE_LOCAL_RECOMMENDER', '')
pin('RECOMMENDER_EVENT_SECRET', '')
pin('XTREAM_HOST', '')
pin('XTREAM_USERNAME', '')
pin('XTREAM_PASSWORD', '')
pin('EEX_TELEMETRY_DSN', '')
pin('ALLOWED_ORIGINS', '')

async function main(): Promise<void> {
  await startStubUpstreams(STUB_PORT)
  console.log(`[integration-server] stub upstreams on :${STUB_PORT}`)

  // Dynamic imports AFTER the env is pinned — server/env.ts reads
  // process.env at module-load time.
  const [{ app }, { setSessionCookie }, { addMember }, { serve }] = await Promise.all([
    import('../../../server/app.js'),
    import('../../../server/session.js'),
    import('../../../server/services/members.js'),
    import('@hono/node-server'),
  ])

  // ── Test-only login (see header comment for why this is safe) ───────
  app.post('/api/test/login', async (c) => {
    // Defense in depth: re-check at request time too, in case this module
    // is ever imported (rather than exec'd) into a differently-configured
    // process.
    if (process.env.NODE_ENV !== 'test') {
      return c.json({ error: 'test_login_disabled' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      sub?: string
      username?: string
      role?: 'admin' | 'user'
    }
    const role = body.role === 'user' ? 'user' : 'admin'
    const sub = body.sub ?? (role === 'admin' ? E2E_ADMIN_SUB : 'plex:1900000002')
    const username = body.username ?? (role === 'admin' ? 'e2e-admin' : 'e2e-user')
    // Non-admin subs aren't in ADMIN_SUBS, and setting ADMIN_SUBS makes
    // the authz allowlist authoritative — give them a members row the
    // same way an invite redemption would.
    if (role === 'user') {
      try {
        addMember({ sub, displayName: username, role, authMode: 'plex' })
      } catch (e) {
        return c.json({ error: 'member_seed_failed', detail: String(e) }, 500)
      }
    }
    await setSessionCookie(c, { sub, username, role, auth_mode: 'plex' })
    return c.json({ ok: true, user: { sub, username, role } })
  })

  serve({ fetch: app.fetch, port: BACKEND_PORT }, (info) => {
    console.log(
      `[integration-server] real backend on http://127.0.0.1:${info.port} (data: ${dataDir})`,
    )
  })
}

void main().catch((err) => {
  console.error('[integration-server] boot failed:', err)
  process.exit(1)
})
