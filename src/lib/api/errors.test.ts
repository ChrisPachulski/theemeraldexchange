// throwApiError is the bridge between backend error envelopes and what
// users actually see in toasts. A regression here means the carefully
// crafted "Not enough disk space. 50 GB free, need 100 GB." message
// silently degrades back to "Sonarr /series: 507 Insufficient Storage".

import { describe, it, expect } from 'vitest'
import { throwApiError, ApiError, isInsufficientDiskSpace } from './errors'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('throwApiError', () => {
  it('translates insufficient_disk_space into a friendly message', async () => {
    const r = jsonResponse(
      {
        error: 'insufficient_disk_space',
        free_bytes: 50 * 1024 ** 3,
        threshold_bytes: 100 * 1024 ** 3,
        path: '/data/tv',
      },
      507,
    )
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect(caught!.status).toBe(507)
    expect(caught!.code).toBe('insufficient_disk_space')
    expect(caught!.message).toMatch(/50\.0 GB free/)
    expect(caught!.message).toMatch(/100 GB/)
  })

  it('translates admin_only forbidden into "admin-only" message', async () => {
    const r = jsonResponse({ error: 'forbidden', reason: 'admin_only' }, 403)
    await expect(throwApiError(r, 'SAB queue')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: expect.stringMatching(/admin-only/i),
    })
  })

  it('handles 401 unauthenticated explicitly', async () => {
    const r = jsonResponse({ error: 'unauthenticated' }, 401)
    await expect(throwApiError(r, 'Sonarr /series')).rejects.toMatchObject({
      message: expect.stringMatching(/sign in again/i),
    })
  })

  it('falls back to status text when the body is not JSON', async () => {
    const r = new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' })
    await expect(throwApiError(r, 'Sonarr /series')).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('502'),
    })
  })

  it('uses data.message when the backend returns one', async () => {
    const r = jsonResponse({ message: 'Custom backend message' }, 500)
    await expect(throwApiError(r, 'Sonarr /series')).rejects.toMatchObject({
      message: 'Custom backend message',
    })
  })

  it('explains default_quality_profile_missing with available names', async () => {
    const r = jsonResponse(
      {
        error: 'default_quality_profile_missing',
        expected_name: 'HD-1080p',
        available_names: ['SD', 'HD-720p'],
      },
      400,
    )
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.status).toBe(400)
    expect(caught!.code).toBe('default_quality_profile_missing')
    expect(caught!.message).toMatch(/No quality profile named "HD-1080p" found/)
    expect(caught!.message).toContain('Available profiles: SD, HD-720p.')
    expect(caught!.message).toMatch(/Set DEFAULT_PROFILE_NAME/)
  })

  it('explains default_quality_profile_missing without available names (fallback name)', async () => {
    const r = jsonResponse({ error: 'default_quality_profile_missing' }, 400)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.message).toMatch(/No quality profile named "choose me" found/)
    expect(caught!.message).not.toContain('Available profiles')
  })

  it('explains default_root_folder_missing with expected and available paths', async () => {
    const r = jsonResponse(
      {
        error: 'default_root_folder_missing',
        expected_path: '/data/tv',
        available_paths: ['/mnt/a', '/mnt/b'],
      },
      400,
    )
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.status).toBe(400)
    expect(caught!.code).toBe('default_root_folder_missing')
    expect(caught!.message).toMatch(/does not match any folder/)
    expect(caught!.message).toContain('Configured: "/data/tv".')
    expect(caught!.message).toContain('Available paths: /mnt/a, /mnt/b.')
  })

  it('explains default_root_folder_missing without expected/available paths', async () => {
    const r = jsonResponse({ error: 'default_root_folder_missing' }, 400)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.message).toMatch(/does not match any folder/)
    expect(caught!.message).not.toContain('Configured:')
    expect(caught!.message).not.toContain('Available paths:')
  })

  it('explains admin_must_configure_upstream', async () => {
    const r = jsonResponse({ error: 'admin_must_configure_upstream' }, 409)
    await expect(throwApiError(r, 'Sonarr /series')).rejects.toMatchObject({
      status: 409,
      code: 'admin_must_configure_upstream',
      message: expect.stringMatching(/no root folders configured/i),
    })
  })

  it('explains rootfolder_unreachable and preserves status', async () => {
    const r = jsonResponse({ error: 'rootfolder_unreachable' }, 502)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.status).toBe(502)
    expect(caught!.code).toBe('rootfolder_unreachable')
    expect(caught!.message).toMatch(/unreachable/i)
    expect(caught!.message).toMatch(/API key/)
  })

  it('explains qualityprofile_unreachable and preserves status', async () => {
    const r = jsonResponse({ error: 'qualityprofile_unreachable' }, 503)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.status).toBe(503)
    expect(caught!.code).toBe('qualityprofile_unreachable')
    expect(caught!.message).toMatch(/unreachable/i)
    expect(caught!.message).toMatch(/API key/)
  })

  it('explains free_space_unknown with a path', async () => {
    const r = jsonResponse({ error: 'free_space_unknown', path: '/data/movies' }, 507)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.status).toBe(507)
    expect(caught!.code).toBe('free_space_unknown')
    expect(caught!.message).toMatch(/cannot read the free-space value/)
    expect(caught!.message).toContain('/data/movies')
  })

  it('handles a 507 status with a non-disk-space code (default path text)', async () => {
    const r = jsonResponse({ error: 'some_other_507' }, 507)
    await expect(throwApiError(r, 'Sonarr /series')).rejects.toMatchObject({
      status: 507,
      message: expect.stringMatching(/cannot read the free-space value for the root folder/),
    })
  })

  it('explains free_space_unknown without a path (default path text)', async () => {
    const r = jsonResponse({ error: 'free_space_unknown' }, 507)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.message).toContain('the root folder')
  })

  it('explains unknown_root_folder with a path', async () => {
    const r = jsonResponse({ error: 'unknown_root_folder', path: '/x/y' }, 422)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.status).toBe(422)
    expect(caught!.code).toBe('unknown_root_folder')
    expect(caught!.message).toMatch(/does not list/)
    expect(caught!.message).toContain('/x/y')
  })

  it('explains unknown_root_folder without a path (default path text)', async () => {
    const r = jsonResponse({ error: 'unknown_root_folder' }, 422)
    let caught: ApiError | null = null
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      caught = e as ApiError
    }
    expect(caught!.message).toContain('the requested path')
  })

  it('explains transcoder_unavailable (busy playback slots) instead of a raw 503', async () => {
    const r = jsonResponse({ error: 'transcoder_unavailable' }, 503)
    await expect(throwApiError(r, 'Media /playback/movie/1')).rejects.toMatchObject({
      status: 503,
      code: 'transcoder_unavailable',
    })
    let msg = ''
    try {
      await throwApiError(jsonResponse({ error: 'transcoder_unavailable' }, 503), 'Media /playback/movie/1')
    } catch (e) {
      msg = (e as ApiError).message
    }
    expect(msg).toMatch(/playback slots are busy/i)
    expect(msg).not.toMatch(/503/)
  })

  it('explains transcode_start_failed / transcoder_unreachable (and the legacy spelling)', async () => {
    for (const code of ['transcode_start_failed', 'transcoder_unreachable', 'transcoder unreachable']) {
      let msg = ''
      try {
        await throwApiError(jsonResponse({ error: code }, 502), 'Media /playback/episode/9')
      } catch (e) {
        msg = (e as ApiError).message
      }
      expect(msg).toMatch(/couldn.t start playback/i)
    }
  })

  it('explains media_core_unreachable instead of a raw 502', async () => {
    let msg = ''
    try {
      await throwApiError(jsonResponse({ error: 'media_core_unreachable' }, 502), 'Media /playback/movie/1')
    } catch (e) {
      msg = (e as ApiError).message
    }
    expect(msg).toMatch(/media library service/i)
    expect(msg).not.toMatch(/502/)
  })

  it('maps a 404 on a playback grant to "not available locally"', async () => {
    let msg = ''
    try {
      await throwApiError(jsonResponse({}, 404), 'Media /playback/movie/999999')
    } catch (e) {
      msg = (e as ApiError).message
    }
    expect(msg).toMatch(/isn.t available to play/i)
  })
})

describe('isInsufficientDiskSpace', () => {
  it('matches an ApiError with the right code', () => {
    const e = new ApiError(507, 'msg', 'insufficient_disk_space', {})
    expect(isInsufficientDiskSpace(e)).toBe(true)
  })

  it('rejects other ApiErrors', () => {
    expect(isInsufficientDiskSpace(new ApiError(403, 'msg', 'forbidden', {}))).toBe(false)
  })

  it('rejects non-ApiError throwables', () => {
    expect(isInsufficientDiskSpace(new Error('plain'))).toBe(false)
    expect(isInsufficientDiskSpace('string')).toBe(false)
    expect(isInsufficientDiskSpace(null)).toBe(false)
  })
})
