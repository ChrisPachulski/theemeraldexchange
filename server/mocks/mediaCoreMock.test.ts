import { describe, expect, it } from 'vitest'
import { app } from './mediaCoreMock.js'
import { MOVIES } from './fixtures.js'

// In-process tests against the Hono mock — no listening socket, mirroring
// server/services/iptvEpgQuery.test.ts's app.request(...) style. These pin the
// CONTRACT the backend proxy (server/routes/media.ts) and the SPA
// (src/lib/api/media.ts) depend on; a shape drift here is the loud signal that
// the mock fell behind media-core.

describe('media-core mock', () => {
  it('paginates /movies and reports the full total (fetchAllPages contract)', async () => {
    // 12 fixtures; page of 5 at offset 10 → the last 2 rows, but total stays 12.
    const res = await app.request('/api/media/movies?limit=5&offset=10')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number }
    expect(body.total).toBe(MOVIES.length)
    // offset 10 of 12 → exactly 2 remaining even though limit=5 was asked.
    expect(body.items.length).toBe(2)

    // And a first page honors the limit exactly.
    const firstPage = await app.request('/api/media/movies?limit=5&offset=0')
    const firstBody = (await firstPage.json()) as { items: unknown[]; total: number }
    expect(firstBody.items.length).toBe(5)
    expect(firstBody.total).toBe(MOVIES.length)
  })

  it('narrows /movies by the q substring filter (case-insensitive)', async () => {
    const res = await app.request('/api/media/movies?q=the%20matrix')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { title: string }[]
      total: number
    }
    expect(body.total).toBe(1)
    expect(body.items[0].title).toBe('The Matrix')

    // A needle matching nothing → empty, total 0.
    const none = await app.request('/api/media/movies?q=zzzznotitle')
    const noneBody = (await none.json()) as { items: unknown[]; total: number }
    expect(noneBody.total).toBe(0)
    expect(noneBody.items.length).toBe(0)
  })

  it('grants direct-play for a known movie and 404s an unknown id', async () => {
    const ok = await app.request('/api/media/play/movie/1/grant', { method: 'POST' })
    expect(ok.status).toBe(200)
    const grant = (await ok.json()) as {
      directPlay: boolean
      file: { duration_secs: number }
    }
    expect(grant.directPlay).toBe(true)
    expect(typeof grant.file.duration_secs).toBe('number')
    expect(grant.file.duration_secs).toBeGreaterThan(0)

    const missing = await app.request('/api/media/play/movie/999999/grant', {
      method: 'POST',
    })
    expect(missing.status).toBe(404)
  })

  it('round-trips a watch upsert: POST then GET reflects the row', async () => {
    const upsert = await app.request('/api/media/watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media_kind: 'movie',
        media_id: 8,
        position_secs: 123,
        duration_secs: 6000,
        completed: false,
      }),
    })
    expect(upsert.status).toBe(200)
    expect((await upsert.json()) as { ok: boolean }).toEqual({ ok: true })

    const list = await app.request('/api/media/watch')
    const body = (await list.json()) as {
      items: { media_kind: string; media_id: number; position_secs: number }[]
    }
    const row = body.items.find((r) => r.media_kind === 'movie' && r.media_id === 8)
    expect(row).toBeDefined()
    expect(row?.position_secs).toBe(123)
  })

  it('serves /stream with a real 206 for a Range request', async () => {
    const res = await app.request('/api/media/stream/movie/1', {
      headers: { range: 'bytes=0-99' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBe(100)
  })

  it('404s an unknown stream id and an unimplemented route loudly', async () => {
    const missing = await app.request('/api/media/stream/movie/424242')
    expect(missing.status).toBe(404)

    const gap = await app.request('/api/media/some/unimplemented/route')
    expect(gap.status).toBe(404)
    const body = (await gap.json()) as { error: string }
    expect(body.error).toBe('mock_unimplemented')
  })
})
