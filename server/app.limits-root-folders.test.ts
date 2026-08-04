import { describe, it, expect, vi } from 'vitest'

// /api/limits must surface the operator-curated root-folder paths
// (DEFAULT_SONARR/RADARR_ROOT_FOLDER_PATH) — but ONLY to signed-in callers.
// Unlike this endpoint's other fields (numbers, booleans, a profile label),
// these are host filesystem paths, so the handler withholds them (returns
// null) for anyone without a valid session cookie; see server/app.ts's
// `/api/limits` comment. The SPA's Add modals and the discover-time
// "Find release" flow ALWAYS submit rootFolderPath, so the server's own
// configuredFolderPath fallback in services/arrAdd.ts never runs to correct
// a client that guessed — if these fields fall off the payload for a
// signed-in caller, the client silently reverts to "whatever folder the
// *arr listed first" and files adds under the wrong root, with no error
// anywhere.
//
// env.ts reads the vars at module load, so set them BEFORE the dynamic import
// and reset the module graph around each case (same shape as app.media-gate).

async function limitsBody(env: Record<string, string | undefined>, opts: { authed?: boolean } = {}) {
  vi.resetModules()
  const keys = ['DEFAULT_ROOT_FOLDER_PATH', 'DEFAULT_SONARR_ROOT_FOLDER_PATH', 'DEFAULT_RADARR_ROOT_FOLDER_PATH']
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) {
    const v = env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const { app } = await import('./app.js')
    const headers: Record<string, string> = {}
    if (opts.authed) {
      const { createSession } = await import('./session.js')
      const token = await createSession({
        sub: 'plex:999999',
        username: 'limits-test-user',
        role: 'user',
        plexAuthToken: 'fake-plex-token',
      })
      headers.Cookie = `eex.session=${token}`
    }
    const r = await app.request('/api/limits', { headers })
    expect(r.status).toBe(200)
    return (await r.json()) as Record<string, unknown>
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    vi.resetModules()
  }
}

describe('/api/limits — curated root folders (client Add-modal default)', () => {
  it('surfaces the per-app curated paths verbatim to a signed-in caller', async () => {
    const body = await limitsBody(
      {
        DEFAULT_SONARR_ROOT_FOLDER_PATH: '/data/media/tv',
        DEFAULT_RADARR_ROOT_FOLDER_PATH: '/data/media/movies',
      },
      { authed: true },
    )
    expect(body.defaultSonarrRootFolderPath).toBe('/data/media/tv')
    expect(body.defaultRadarrRootFolderPath).toBe('/data/media/movies')
  })

  it('withholds the paths from an unauthenticated caller even when configured', async () => {
    // The gate itself: same env as the test above, no session cookie.
    // Filesystem layout is a different disclosure class than the rest of
    // this public-ish endpoint, so it must not leak pre-auth.
    const body = await limitsBody({
      DEFAULT_SONARR_ROOT_FOLDER_PATH: '/data/media/tv',
      DEFAULT_RADARR_ROOT_FOLDER_PATH: '/data/media/movies',
    })
    expect(body).toHaveProperty('defaultSonarrRootFolderPath', null)
    expect(body).toHaveProperty('defaultRadarrRootFolderPath', null)
    // The rest of the endpoint stays public — the gate is scoped to just
    // these two fields, not the whole route.
    expect(typeof body.minFreeGb).toBe('number')
  })

  it('falls back to the shared DEFAULT_ROOT_FOLDER_PATH like env.ts does, for a signed-in caller', async () => {
    const body = await limitsBody({ DEFAULT_ROOT_FOLDER_PATH: '/data/media' }, { authed: true })
    expect(body.defaultSonarrRootFolderPath).toBe('/data/media')
    expect(body.defaultRadarrRootFolderPath).toBe('/data/media')
  })

  it('reports null (not undefined) for a signed-in caller when nothing is configured', async () => {
    const body = await limitsBody({}, { authed: true })
    // The keys must be PRESENT and null — an absent key and a null one behave
    // the same in the client helper, but null proves the field survived JSON
    // serialization rather than the handler having dropped it.
    expect(body).toHaveProperty('defaultSonarrRootFolderPath', null)
    expect(body).toHaveProperty('defaultRadarrRootFolderPath', null)
  })

  it('does not leak the paths into any other field or clobber defaultProfileName', async () => {
    const body = await limitsBody(
      {
        DEFAULT_SONARR_ROOT_FOLDER_PATH: '/data/media/tv',
        DEFAULT_RADARR_ROOT_FOLDER_PATH: '/data/media/movies',
      },
      { authed: true },
    )
    // The two apps must stay distinct — a copy/paste swap here would file every
    // movie under the TV root and vice versa, which nothing downstream catches.
    expect(body.defaultSonarrRootFolderPath).not.toBe(body.defaultRadarrRootFolderPath)
    expect(typeof body.defaultProfileName).toBe('string')
  })
})
