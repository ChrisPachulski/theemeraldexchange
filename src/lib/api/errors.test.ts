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
    try {
      await throwApiError(r, 'SAB queue')
    } catch (e) {
      expect((e as ApiError).status).toBe(403)
      expect((e as ApiError).code).toBe('forbidden')
      expect((e as Error).message).toMatch(/admin-only/i)
    }
  })

  it('handles 401 unauthenticated explicitly', async () => {
    const r = jsonResponse({ error: 'unauthenticated' }, 401)
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      expect((e as Error).message).toMatch(/sign in again/i)
    }
  })

  it('falls back to status text when the body is not JSON', async () => {
    const r = new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' })
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      expect((e as ApiError).status).toBe(502)
      expect((e as Error).message).toContain('502')
    }
  })

  it('uses data.message when the backend returns one', async () => {
    const r = jsonResponse({ message: 'Custom backend message' }, 500)
    try {
      await throwApiError(r, 'Sonarr /series')
    } catch (e) {
      expect((e as Error).message).toBe('Custom backend message')
    }
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
