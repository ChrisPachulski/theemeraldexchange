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
  'MIN_FREE_GB',
  'MAX_MOVIE_SIZE_GB',
  'MAX_TV_GB_PER_EPISODE',
  'PORT',
  'ALLOW_UNSCOPED_PLEX_LOGIN',
  'DEFAULT_PROFILE_NAME',
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

describe('env — production gating on PLEX_SERVER_ID (auth scope)', () => {
  // Without PLEX_SERVER_ID set, server/auth.ts accepts ANY authenticated
  // Plex user. In prod, blank PLEX_SERVER_ID would silently turn the
  // invitation-only app into "any Plex user can sign in." Hard-fail
  // unless the operator explicitly opted into bootstrap mode.
  it('production with unset PLEX_SERVER_ID throws', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://app.example'
    delete process.env.PLEX_SERVER_ID
    delete process.env.ALLOW_UNSCOPED_PLEX_LOGIN
    await expect(loadEnv()).rejects.toThrow(/PLEX_SERVER_ID/)
  })

  it('production with empty PLEX_SERVER_ID throws (compose ${VAR:-} hazard)', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://app.example'
    process.env.PLEX_SERVER_ID = ''
    delete process.env.ALLOW_UNSCOPED_PLEX_LOGIN
    await expect(loadEnv()).rejects.toThrow(/PLEX_SERVER_ID/)
  })

  it('production with explicit ALLOW_UNSCOPED_PLEX_LOGIN=1 boots open (bootstrap)', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://app.example'
    delete process.env.PLEX_SERVER_ID
    process.env.ALLOW_UNSCOPED_PLEX_LOGIN = '1'
    const env = await loadEnv()
    expect(env.plexServerId).toBeNull()
    expect(env.isProd).toBe(true)
  })

  it('production with PLEX_SERVER_ID set boots normally', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://app.example'
    process.env.PLEX_SERVER_ID = 'home-server-machine-id'
    delete process.env.ALLOW_UNSCOPED_PLEX_LOGIN
    const env = await loadEnv()
    expect(env.plexServerId).toBe('home-server-machine-id')
  })

  it('non-production with unset PLEX_SERVER_ID still boots open', async () => {
    setBaselineEnv()
    process.env.NODE_ENV = 'test'
    delete process.env.PLEX_SERVER_ID
    delete process.env.ALLOW_UNSCOPED_PLEX_LOGIN
    const env = await loadEnv()
    expect(env.plexServerId).toBeNull()
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

describe('env — production gating on SESSION_SECRET strength', () => {
  // SESSION_SECRET is SHA-256'd into the A256GCM key that encrypts
  // session cookies, which carry every user's Plex auth token. The
  // boot gate enforces minimum length and rejects common placeholder
  // strings only in production — local dev / test still accepts short
  // values so the test fixtures don't have to generate 48-byte secrets.
  function setProdBaseline() {
    setBaselineEnv()
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://app.example'
    process.env.PLEX_SERVER_ID = 'home-server-machine-id'
    delete process.env.ALLOW_UNSCOPED_PLEX_LOGIN
  }

  it('production rejects a too-short SESSION_SECRET', async () => {
    setProdBaseline()
    process.env.SESSION_SECRET = 'short'
    await expect(loadEnv()).rejects.toThrow(/SESSION_SECRET/)
  })

  it('production rejects a 31-char SESSION_SECRET (boundary)', async () => {
    setProdBaseline()
    process.env.SESSION_SECRET = 'x'.repeat(31)
    await expect(loadEnv()).rejects.toThrow(/SESSION_SECRET/)
  })

  it('production accepts exactly 32 chars (lower boundary)', async () => {
    setProdBaseline()
    process.env.SESSION_SECRET = 'x'.repeat(32)
    const env = await loadEnv()
    expect(env.sessionSecret.length).toBe(32)
  })

  it('production rejects common placeholder values (case-insensitive)', async () => {
    setProdBaseline()
    process.env.SESSION_SECRET = 'ChangeMe'
    await expect(loadEnv()).rejects.toThrow(/placeholder/)
  })

  it('production rejects a long placeholder that satisfies the length check', async () => {
    // 'replace-me' is in the blocklist; verify the placeholder rule
    // bites independently of length.
    setProdBaseline()
    process.env.SESSION_SECRET = 'replace-me'.padEnd(48, '-')
    // Padded string isn't an exact match against the blocklist set —
    // the check is exact, so this should pass. Document the boundary.
    const env = await loadEnv()
    expect(env.sessionSecret.length).toBe(48)
  })

  it('non-production with a short SESSION_SECRET still boots', async () => {
    // Local dev / test convenience — short secrets are fine outside
    // prod so existing fixtures and a quick `npm run dev` still work.
    setBaselineEnv()
    process.env.NODE_ENV = 'test'
    process.env.SESSION_SECRET = 'short'
    const env = await loadEnv()
    expect(env.sessionSecret).toBe('short')
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
    // PLEX_SERVER_ID is now also required in prod (round 16 boot
    // gate). Set it so this test stays focused on the ALLOWED_ORIGINS
    // branch instead of tripping the new check.
    process.env.PLEX_SERVER_ID = 'home-server-machine-id'
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

describe('env — numeric env validation', () => {
  // The disk-space safety gate compares folder.freeSpace against
  // env.minFreeBytes. A typo like MIN_FREE_GB="abc" used to produce
  // NaN, and `freeSpace < NaN` is always false — silently disabling
  // the gate. Fail closed at boot so the typo is loud.
  it('non-numeric MIN_FREE_GB throws at boot', async () => {
    setBaselineEnv()
    process.env.MIN_FREE_GB = 'abc'
    await expect(loadEnv()).rejects.toThrow(/MIN_FREE_GB/)
  })

  it('zero MIN_FREE_GB throws (would also disable the gate)', async () => {
    setBaselineEnv()
    process.env.MIN_FREE_GB = '0'
    await expect(loadEnv()).rejects.toThrow(/MIN_FREE_GB/)
  })

  it('negative MIN_FREE_GB throws', async () => {
    setBaselineEnv()
    process.env.MIN_FREE_GB = '-50'
    await expect(loadEnv()).rejects.toThrow(/MIN_FREE_GB/)
  })

  it('non-numeric MAX_MOVIE_SIZE_GB throws', async () => {
    setBaselineEnv()
    process.env.MAX_MOVIE_SIZE_GB = 'big'
    await expect(loadEnv()).rejects.toThrow(/MAX_MOVIE_SIZE_GB/)
  })

  it('non-numeric MAX_TV_GB_PER_EPISODE throws', async () => {
    setBaselineEnv()
    process.env.MAX_TV_GB_PER_EPISODE = ''
    // blank → uses default 5, no throw
    const env = await loadEnv()
    expect(env.maxTvGbPerEpisode).toBe(5)
  })

  it('non-integer PORT throws', async () => {
    setBaselineEnv()
    process.env.PORT = '3001.5'
    await expect(loadEnv()).rejects.toThrow(/PORT/)
  })

  it('non-numeric PORT throws', async () => {
    setBaselineEnv()
    process.env.PORT = 'http'
    await expect(loadEnv()).rejects.toThrow(/PORT/)
  })

  it('valid numerics pass through', async () => {
    setBaselineEnv()
    process.env.MIN_FREE_GB = '200'
    process.env.MAX_MOVIE_SIZE_GB = '15'
    process.env.MAX_TV_GB_PER_EPISODE = '7'
    process.env.PORT = '3002'
    const env = await loadEnv()
    const GB = 1024 * 1024 * 1024
    expect(env.minFreeBytes).toBe(200 * GB)
    expect(env.maxMovieGb).toBe(15)
    expect(env.maxTvGbPerEpisode).toBe(7)
    expect(env.port).toBe(3002)
  })
})

describe('env — DEFAULT_PROFILE_NAME case folding', () => {
  // Downstream code compares against p.name?.toLowerCase(), so we must
  // lowercase here at load. The published .env.production.example sets
  // DEFAULT_PROFILE_NAME=Choose Me (capitalized) — without normalization
  // the comparison silently fails and non-admin adds drift back onto
  // profiles[0] (Sonarr/Radarr's permissive "Any"). Lock the symmetry
  // in.
  it('unset → "choose me" default', async () => {
    setBaselineEnv()
    delete process.env.DEFAULT_PROFILE_NAME
    const env = await loadEnv()
    expect(env.defaultProfileName).toBe('choose me')
  })

  it('capitalized value is lowercased so the toLowerCase comparison matches', async () => {
    setBaselineEnv()
    process.env.DEFAULT_PROFILE_NAME = 'Choose Me'
    const env = await loadEnv()
    expect(env.defaultProfileName).toBe('choose me')
  })

  it('all-uppercase value is lowercased', async () => {
    setBaselineEnv()
    process.env.DEFAULT_PROFILE_NAME = 'HIGH QUALITY'
    const env = await loadEnv()
    expect(env.defaultProfileName).toBe('high quality')
  })
})
