// env.ts is loaded exactly once at boot and exposes a frozen object,
// so the only way to exercise its branches is to mutate process.env
// and re-import the module per case via vi.resetModules.
//
// What we lock down here:
//   - blank optional URL env vars (the docker-compose ${VAR:-} expansion
//     hands us empty strings, not undefined) fall back to NAS defaults
//   - production with empty ALLOWED_ORIGINS throws at boot — CSRF
//     defense relies on it, fail-closed beats fail-open
//   - production with a valid allowlist boots cleanly
//   - blank PLEX_SERVER_ID coerces to null (sentinel the auth flow uses)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const PRESERVED_KEYS = [
  'NODE_ENV',
  'PLEX_CLIENT_ID',
  'SESSION_SECRET',
  'SONARR_API_KEY',
  'RADARR_API_KEY',
  'SAB_API_KEY',
  'SONARR_URL',
  'RADARR_URL',
  'SAB_URL',
  'PLEX_SERVER_URL',
  'PLEX_SERVER_ID',
  'ALLOWED_ORIGINS',
] as const

let snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  snapshot = Object.fromEntries(PRESERVED_KEYS.map((k) => [k, process.env[k]]))
  vi.resetModules()
})

afterEach(() => {
  for (const k of PRESERVED_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
  vi.resetModules()
})

function setBaselineEnv() {
  // The required-in-all-modes set. Tests override specific keys on top.
  process.env.PLEX_CLIENT_ID = 'test-client'
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-test-secret'
  process.env.SONARR_API_KEY = 'k'
  process.env.RADARR_API_KEY = 'k'
  process.env.SAB_API_KEY = 'k'
}

async function loadEnv(): Promise<typeof import('./env.js')['env']> {
  const mod = await import('./env.js')
  return mod.env
}

describe('env — blank URL fallbacks', () => {
  it('blank SONARR_URL falls back to NAS host', async () => {
    setBaselineEnv()
    process.env.SONARR_URL = ''
    const env = await loadEnv()
    expect(env.sonarrUrl).toBe('http://theemeraldexchange.local:8989/tv')
  })

  it('blank RADARR_URL falls back to NAS host', async () => {
    setBaselineEnv()
    process.env.RADARR_URL = ''
    const env = await loadEnv()
    expect(env.radarrUrl).toBe('http://theemeraldexchange.local:7878/movies')
  })

  it('blank SAB_URL falls back to NAS host', async () => {
    setBaselineEnv()
    process.env.SAB_URL = ''
    const env = await loadEnv()
    expect(env.sabUrl).toBe('http://theemeraldexchange.local:8080')
  })

  it('blank PLEX_SERVER_URL falls back to NAS host', async () => {
    setBaselineEnv()
    process.env.PLEX_SERVER_URL = ''
    const env = await loadEnv()
    expect(env.plexServerUrl).toBe('http://theemeraldexchange.local:32400')
  })

  it('whitespace-only URLs also fall back (no silent ghost values)', async () => {
    setBaselineEnv()
    process.env.SONARR_URL = '   '
    process.env.RADARR_URL = '\t'
    const env = await loadEnv()
    expect(env.sonarrUrl).toBe('http://theemeraldexchange.local:8989/tv')
    expect(env.radarrUrl).toBe('http://theemeraldexchange.local:7878/movies')
  })

  it('explicit URLs are used as-is', async () => {
    setBaselineEnv()
    process.env.SONARR_URL = 'http://my-nas:8989'
    process.env.RADARR_URL = 'http://my-nas:7878'
    const env = await loadEnv()
    expect(env.sonarrUrl).toBe('http://my-nas:8989')
    expect(env.radarrUrl).toBe('http://my-nas:7878')
  })
})

describe('env — PLEX_SERVER_ID null coercion', () => {
  it('unset → null', async () => {
    setBaselineEnv()
    delete process.env.PLEX_SERVER_ID
    const env = await loadEnv()
    expect(env.plexServerId).toBeNull()
  })

  it('blank string → null (compose ${VAR:-} expansion hazard)', async () => {
    setBaselineEnv()
    process.env.PLEX_SERVER_ID = ''
    const env = await loadEnv()
    expect(env.plexServerId).toBeNull()
  })

  it('explicit value → kept', async () => {
    setBaselineEnv()
    process.env.PLEX_SERVER_ID = 'abc123machineid'
    const env = await loadEnv()
    expect(env.plexServerId).toBe('abc123machineid')
  })
})

describe('env — production gating on ALLOWED_ORIGINS', () => {
  it('production with empty ALLOWED_ORIGINS throws', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = ''
    await expect(loadEnv()).rejects.toThrow(/ALLOWED_ORIGINS/)
  })

  it('production with unset ALLOWED_ORIGINS throws', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    delete process.env.ALLOWED_ORIGINS
    await expect(loadEnv()).rejects.toThrow(/ALLOWED_ORIGINS/)
  })

  it('production with whitespace-only ALLOWED_ORIGINS throws', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = '  ,  ,   '
    await expect(loadEnv()).rejects.toThrow(/ALLOWED_ORIGINS/)
  })

  it('production with a valid ALLOWED_ORIGINS boots', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://app.example,https://staging.example'
    const env = await loadEnv()
    expect(env.isProd).toBe(true)
    expect(env.allowedOrigins).toEqual(['https://app.example', 'https://staging.example'])
  })

  it('non-production with empty ALLOWED_ORIGINS is fine', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'test'
    process.env.ALLOWED_ORIGINS = ''
    const env = await loadEnv()
    expect(env.isProd).toBe(false)
    expect(env.allowedOrigins).toEqual([])
  })
})
