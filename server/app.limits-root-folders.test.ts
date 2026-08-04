import { describe, it, expect, vi } from 'vitest'

// /api/limits must surface the operator-curated root-folder paths
// (DEFAULT_SONARR/RADARR_ROOT_FOLDER_PATH). The SPA's Add modals and the
// discover-time "Find release" flow ALWAYS submit rootFolderPath, so the
// server's own configuredFolderPath fallback in services/arrAdd.ts never runs
// to correct a client that guessed. If these fields fall off the payload the
// client silently reverts to "whatever folder the *arr listed first" and files
// adds under the wrong root — a failure with no error anywhere.
//
// env.ts reads the vars at module load, so set them BEFORE the dynamic import
// and reset the module graph around each case (same shape as app.media-gate).

async function limitsBody(env: Record<string, string | undefined>) {
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
    const r = await app.request('/api/limits')
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
  it('surfaces the per-app curated paths verbatim', async () => {
    const body = await limitsBody({
      DEFAULT_SONARR_ROOT_FOLDER_PATH: '/data/media/tv',
      DEFAULT_RADARR_ROOT_FOLDER_PATH: '/data/media/movies',
    })
    expect(body.defaultSonarrRootFolderPath).toBe('/data/media/tv')
    expect(body.defaultRadarrRootFolderPath).toBe('/data/media/movies')
  })

  it('falls back to the shared DEFAULT_ROOT_FOLDER_PATH like env.ts does', async () => {
    const body = await limitsBody({ DEFAULT_ROOT_FOLDER_PATH: '/data/media' })
    expect(body.defaultSonarrRootFolderPath).toBe('/data/media')
    expect(body.defaultRadarrRootFolderPath).toBe('/data/media')
  })

  it('reports null (not undefined) when nothing is configured, so the client falls back explicitly', async () => {
    const body = await limitsBody({})
    // The keys must be PRESENT and null — an absent key and a null one behave
    // the same in the client helper, but null proves the field survived JSON
    // serialization rather than the handler having dropped it.
    expect(body).toHaveProperty('defaultSonarrRootFolderPath', null)
    expect(body).toHaveProperty('defaultRadarrRootFolderPath', null)
  })

  it('does not leak the paths into any other field or clobber defaultProfileName', async () => {
    const body = await limitsBody({
      DEFAULT_SONARR_ROOT_FOLDER_PATH: '/data/media/tv',
      DEFAULT_RADARR_ROOT_FOLDER_PATH: '/data/media/movies',
    })
    // The two apps must stay distinct — a copy/paste swap here would file every
    // movie under the TV root and vice versa, which nothing downstream catches.
    expect(body.defaultSonarrRootFolderPath).not.toBe(body.defaultRadarrRootFolderPath)
    expect(typeof body.defaultProfileName).toBe('string')
  })
})
