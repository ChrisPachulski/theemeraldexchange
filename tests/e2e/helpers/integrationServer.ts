// REAL-backend bootstrap for the e2e integration tier. Launched by
// playwright's webServer (see playwright.config.ts, PW_INTEGRATION=1) as:
//   tsx tests/e2e/helpers/integrationServer.ts
//
// What it boots, in order:
//   1. the all-upstreams stub (tests/e2e/helpers/stubUpstreams.ts) on
//      EEX_E2E_STUB_PORT — Radarr/Sonarr/SAB/media-core/transcoder at the
//      HTTP boundary, nothing else faked;
//   2. the REAL Rust gateway (target/debug/eex-gateway, or EEX_GATEWAY_BIN)
//      on EEX_E2E_BACKEND_PORT with a throwaway data dir in os.tmpdir() and
//      every upstream URL pointed at the stub.
//
// The gateway's environment is pinned here and nothing else is inherited
// (only PATH, so it finds ffprobe for its boot check): a stray developer
// shell must not leak a real TMDB key or provider host into the run. Specs
// sign in with a cookie minted under the same throwaway SESSION_SECRET
// (tests/e2e/helpers/session.ts); the gateway has no test-only route.
//
// The Vite dev server (second webServer entry) proxies /api/* here, so the
// browser exercises the same-origin path real dev traffic uses.

import { spawn } from 'child_process'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { E2E_ADMIN_SUB, E2E_SESSION_SECRET } from './session.js'
import { startStubUpstreams } from './stubUpstreams.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const GATEWAY_BIN =
  process.env.EEX_GATEWAY_BIN ?? join(REPO_ROOT, 'target', 'debug', 'eex-gateway')
const BACKEND_PORT = Number(process.env.EEX_E2E_BACKEND_PORT ?? 3105)
const STUB_PORT = Number(process.env.EEX_E2E_STUB_PORT ?? 3106)
const STUB = `http://127.0.0.1:${STUB_PORT}`

if (!existsSync(GATEWAY_BIN)) {
  console.error(
    `[integration-server] no gateway binary at ${GATEWAY_BIN}. ` +
      'Build it first: cargo build -p gateway --bin eex-gateway',
  )
  process.exit(1)
}

// Throwaway sqlite + JSON/JSONL data, wiped with the tmpdir.
const dataDir = mkdtempSync(join(tmpdir(), 'eex-e2e-'))
const data = (name: string) => join(dataDir, name)

const env: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  NODE_ENV: 'test',
  RUST_LOG: 'eex_gateway=info,gateway=info,auth=info',
  PORT: String(BACKEND_PORT),
  // Same placeholder secrets the Rust tests use; never real ones.
  SESSION_SECRET: E2E_SESSION_SECRET,
  STREAM_TOKEN_SECRET: 'stream-token-secret-test-placeholder-xxxxxxxxx',
  DEVICE_TOKEN_SECRET: 'device-token-secret-test-placeholder-yyyyyyyyy',
  INTERNAL_PRINCIPAL_SECRET: 'internal-principal-secret-test-placeholder-zzz',
  ADMIN_SUBS: E2E_ADMIN_SUB,
  SERVE_SPA: '0',
  MIN_FREE_GB: '100',
  SERVER_DB_PATH: data('server.db'),
  MEDIA_DB_PATH: data('media.db'),
  RECOMMENDER_DB_PATH: data('exchange.db'),
  REJECTIONS_PATH: data('rejections.json'),
  USER_FEEDBACK_PATH: data('user-feedback.json'),
  USER_WATCHLIST_PATH: data('user-watchlist.json'),
  USER_POLICIES_PATH: data('user-policies.json'),
  USAGE_LOG_PATH: data('usage.jsonl'),
  GRAB_LOG_PATH: data('grabs.jsonl'),
  DB_BACKUP_DIR: data('backups'),
  // Every upstream → the stub.
  SONARR_URL: `${STUB}/sonarr`,
  SONARR_API_KEY: 'test-sonarr-key',
  RADARR_URL: `${STUB}/radarr`,
  RADARR_API_KEY: 'test-radarr-key',
  SAB_URL: `${STUB}/sab`,
  SAB_API_KEY: 'test-sab-key',
  // /api/transcode (the playback spec's proxy path) only mounts with
  // media-core enabled.
  USE_MEDIA_CORE: '1',
  MEDIA_CORE_URL: `${STUB}/media-core`,
  MEDIA_TRANSCODER_URL: `${STUB}/transcoder`,
  // No TMDB key, no local recommender, no telemetry: the suggestions route
  // degrades to its documented 503 (coreFlows.spec.ts asserts it).
}

async function main(): Promise<void> {
  await startStubUpstreams(STUB_PORT)
  console.log(`[integration-server] stub upstreams on :${STUB_PORT}`)

  const gateway = spawn(GATEWAY_BIN, [], { env, stdio: 'inherit' })
  console.log(
    `[integration-server] real gateway on http://127.0.0.1:${BACKEND_PORT} (data: ${dataDir})`,
  )
  const stop = () => gateway.kill('SIGTERM')
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  gateway.on('exit', (code, signal) => {
    console.log(`[integration-server] gateway exited (code ${code}, signal ${signal})`)
    process.exit(code ?? 0)
  })
}

void main().catch((err) => {
  console.error('[integration-server] boot failed:', err)
  process.exit(1)
})
