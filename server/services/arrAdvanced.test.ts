// Unit tests for the shared Advanced-options helpers. The route suites
// (sonarr/radarr.test.ts) exercise these through HTTP, but a few pure-function
// branches — the reservation-refused (no_space) grab path, the full
// interactiveGrabResponse status map, and the input-rejection branches of the
// projection/allowlist helpers — are cleanest (and fully) covered directly
// here. These assert real behavior (returned shapes, dropped fields, ordering,
// side effects), not just that a function ran.

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Env } from '../middleware/auth.js'
import type { ArrGrabEvent, ReservationLedger, RootFolderSpaceSnapshot } from './arrGrab.js'
import {
  buildCommandBody,
  executeInteractiveGrab,
  extractEditPatch,
  interactiveGrabResponse,
  mapHistory,
  mergeEdit,
  parseInteractiveGrab,
  projectRelease,
  type CommandSpec,
  type InteractiveGrabResult,
  type UpstreamRelease,
} from './arrAdvanced.js'

const GB = 1e9

describe('projectRelease', () => {
  const cap = () => 5 * GB // 5 GB cap
  function raw(over: Partial<UpstreamRelease> = {}): UpstreamRelease {
    return {
      guid: 'g', indexerId: 1, title: 'T', size: 3 * GB, qualityWeight: 40,
      quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }],
      protocol: 'usenet', seeders: 12, indexer: 'Eweka', ageHours: 5,
      rejected: false, rejections: [], ...over,
    }
  }

  it('computes sizeGb (2dp) and overCap against the cap fn', () => {
    expect(projectRelease(raw({ size: 3 * GB }), cap).overCap).toBe(false)
    const over = projectRelease(raw({ size: 12 * GB }), cap)
    expect(over.overCap).toBe(true)
    expect(over.sizeGb).toBe(12)
  })

  it('treats a null cap as not-over (fail open)', () => {
    expect(projectRelease(raw({ size: 99 * GB }), () => null).overCap).toBe(false)
  })

  it('defaults missing/garbage fields (size→0, protocol/quality strings, languages [])', () => {
    const p = projectRelease(
      { guid: 'g', indexerId: 1, title: 'T', size: NaN, qualityWeight: 0 } as UpstreamRelease,
      cap,
    )
    expect(p.size).toBe(0)
    expect(p.sizeGb).toBe(0)
    expect(p.protocol).toBe('unknown')
    expect(p.quality).toBe('Unknown')
    expect(p.languages).toEqual([])
    expect(p.rejections).toEqual([])
  })

  it('derives ageHours from `age` (days) when ageHours is absent', () => {
    const p = projectRelease(raw({ ageHours: undefined, age: 2 }), cap)
    expect(p.ageHours).toBe(48)
  })

  it('marks rejected when temporarilyRejected is set', () => {
    expect(projectRelease(raw({ rejected: false, temporarilyRejected: true }), cap).rejected).toBe(true)
  })
})

describe('buildCommandBody', () => {
  const allow: Record<string, CommandSpec> = {
    RefreshSeries: { passthrough: ['seriesId'] },
    EpisodeSearch: { requires: ['episodeIds'], passthrough: ['episodeIds'] },
  }

  it('rejects a non-object body', () => {
    expect(buildCommandBody(null, allow)).toEqual({ ok: false, error: 'invalid_body' })
    expect(buildCommandBody([1], allow)).toEqual({ ok: false, error: 'invalid_body' })
  })

  it('rejects a disallowed command name', () => {
    expect(buildCommandBody({ name: 'Backup' }, allow)).toEqual({ ok: false, error: 'command_not_allowed' })
  })

  it('rejects a missing required field and an empty required array', () => {
    expect(buildCommandBody({ name: 'EpisodeSearch' }, allow)).toEqual({ ok: false, error: 'missing_required_field' })
    expect(buildCommandBody({ name: 'EpisodeSearch', episodeIds: [] }, allow)).toEqual({ ok: false, error: 'missing_required_field' })
  })

  it('forwards only allowlisted fields, dropping extras', () => {
    const r = buildCommandBody({ name: 'RefreshSeries', seriesId: 5, evil: 'x' }, allow)
    expect(r).toEqual({ ok: true, body: { name: 'RefreshSeries', seriesId: 5 } })
  })
})

describe('extractEditPatch', () => {
  it('keeps only well-typed allowlisted fields', () => {
    expect(
      extractEditPatch({
        monitored: false, qualityProfileId: 7, rootFolderPath: '/data',
        title: 'HACK', path: '/etc', id: 9,
      }),
    ).toEqual({ monitored: false, qualityProfileId: 7, rootFolderPath: '/data' })
  })

  it('drops wrong-typed values rather than coercing them', () => {
    expect(
      extractEditPatch({ monitored: 'yes', qualityProfileId: '7', rootFolderPath: '' }),
    ).toEqual({})
  })

  it('returns an empty patch for a non-object', () => {
    expect(extractEditPatch(null)).toEqual({})
    expect(extractEditPatch([1])).toEqual({})
  })
})

describe('mergeEdit', () => {
  it('overlays only the patch keys onto the full object', () => {
    const full = { id: 5, title: 'Keep', monitored: true, qualityProfileId: 1 }
    expect(mergeEdit(full, { monitored: false, qualityProfileId: 9 })).toEqual({
      id: 5, title: 'Keep', monitored: false, qualityProfileId: 9,
    })
  })
})

describe('mapHistory', () => {
  it('accepts a bare array and a paged {records} envelope', () => {
    const rec = { date: '2026-06-20T00:00:00Z', eventType: 'grabbed', sourceTitle: 'X', quality: { quality: { name: 'WEBDL-1080p' } } }
    expect(mapHistory([rec])).toHaveLength(1)
    expect(mapHistory({ records: [rec] })).toHaveLength(1)
  })

  it('returns [] for an unusable payload', () => {
    expect(mapHistory(null)).toEqual([])
    expect(mapHistory({ nope: true })).toEqual([])
  })

  it('sorts newest-first and sinks bad/missing dates to the bottom', () => {
    const out = mapHistory([
      { date: '2026-06-01T00:00:00Z', eventType: 'grabbed', sourceTitle: 'old' },
      { date: 'not-a-date', eventType: 'grabbed', sourceTitle: 'bad' },
      { date: '2026-06-20T00:00:00Z', eventType: 'grabbed', sourceTitle: 'new' },
    ])
    expect(out.map((r) => r.sourceTitle)).toEqual(['new', 'old', 'bad'])
    // Defaults applied to the row missing fields.
    expect(out[2].quality).toBe('Unknown')
  })

  it('carries optional seasonNumber/episodeId only when numeric', () => {
    const [a] = mapHistory([{ date: 'd', eventType: 'grabbed', sourceTitle: 't', seasonNumber: 2, episodeId: 9 }])
    expect(a.seasonNumber).toBe(2)
    expect(a.episodeId).toBe(9)
    const [b] = mapHistory([{ date: 'd', eventType: 'grabbed', sourceTitle: 't' }])
    expect(b.seasonNumber).toBeUndefined()
    expect(b.episodeId).toBeUndefined()
  })
})

describe('parseInteractiveGrab', () => {
  it('rejects bad bodies', () => {
    expect(parseInteractiveGrab(null).ok).toBe(false)
    expect(parseInteractiveGrab({ guid: '', indexerId: 1 }).ok).toBe(false)
    expect(parseInteractiveGrab({ guid: 'g', indexerId: 'x' }).ok).toBe(false)
  })

  it('parses a valid body and defaults allowOverCap to false', () => {
    const r = parseInteractiveGrab({ guid: 'g', indexerId: 9 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.req).toEqual({ guid: 'g', indexerId: 9, allowOverCap: false })
  })

  it('honors allowOverCap:true', () => {
    const r = parseInteractiveGrab({ guid: 'g', indexerId: 9, allowOverCap: true })
    if (r.ok) expect(r.req.allowOverCap).toBe(true)
  })
})

describe('interactiveGrabResponse — every status maps to the contract', () => {
  const c = () => {
    const app = new Hono<Env>()
    let captured!: Response
    app.get('/', (ctx) => {
      captured = interactiveGrabResponse(ctx, statusUnderTest)
      return captured
    })
    return app
  }
  let statusUnderTest: InteractiveGrabResult

  async function run(result: InteractiveGrabResult): Promise<{ status: number; body: unknown }> {
    statusUnderTest = result
    const res = await c().request('/')
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  it('grabbed → 200', async () => {
    expect(await run({ status: 'grabbed', title: 'T', sizeGb: 3 })).toEqual({
      status: 200, body: { status: 'grabbed', title: 'T', sizeGb: 3 },
    })
  })
  it('over_cap → 424', async () => {
    const r = await run({ status: 'over_cap' })
    expect(r.status).toBe(424)
    expect((r.body as { error: string }).error).toBe('over_cap')
  })
  it('release_not_found → 404', async () => {
    expect((await run({ status: 'release_not_found' })).status).toBe(404)
  })
  it('bad_request → 400 invalid_body', async () => {
    const r = await run({ status: 'bad_request' })
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_body')
  })
  it('no_space → 507 insufficient_disk_space', async () => {
    const r = await run({ status: 'no_space' })
    expect(r.status).toBe(507)
    expect((r.body as { error: string }).error).toBe('insufficient_disk_space')
  })
  it('upstream_error → 502 grab_failed with status', async () => {
    const r = await run({ status: 'upstream_error', upstreamStatus: 503 })
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'grab_failed', status: 503 })
  })
})

describe('executeInteractiveGrab', () => {
  const folder: RootFolderSpaceSnapshot = { path: '/data', freeSpace: 100 * GB }
  function pick(size = 3 * GB): UpstreamRelease {
    return { guid: 'g', indexerId: 9, title: 'Picked', size, qualityWeight: 50 }
  }
  const baseOpts = () => ({
    itemId: 5,
    sub: 'plex:1',
    capGb: 5,
    capBytesFor: () => 5 * GB,
    listReleases: vi.fn(async () => [pick()]),
    postGrab: vi.fn(async () => ({ ok: true, status: 200 })),
    recordEvent: vi.fn(async (_event: ArrGrabEvent) => {}),
  })

  it('returns no_space when the ledger refuses the reservation (and never POSTs the grab)', async () => {
    const ledger: ReservationLedger = {
      availableBytes: () => 0,
      pendingBytes: () => 0,
      reserve: vi.fn(() => false), // refuse
      release: vi.fn(),
    }
    const opts = baseOpts()
    const result = await executeInteractiveGrab({
      ...opts,
      req: { guid: 'g', indexerId: 9 },
      ledger,
      folder,
    })
    expect(result).toEqual({ status: 'no_space' })
    expect(ledger.reserve).toHaveBeenCalledOnce()
    expect(opts.postGrab).not.toHaveBeenCalled()
    // grab_started was recorded before the reservation was attempted.
    const types = opts.recordEvent.mock.calls.map(([e]) => (e as { type: string }).type)
    expect(types).toContain('grab_started')
  })

  it('reserves then releases around a successful grab', async () => {
    const ledger: ReservationLedger = {
      availableBytes: () => 100 * GB,
      pendingBytes: () => 0,
      reserve: vi.fn(() => true),
      release: vi.fn(),
    }
    const opts = baseOpts()
    const result = await executeInteractiveGrab({
      ...opts,
      req: { guid: 'g', indexerId: 9 },
      ledger,
      folder,
    })
    expect(result).toEqual({ status: 'grabbed', title: 'Picked', sizeGb: 3 })
    expect(ledger.reserve).toHaveBeenCalledOnce()
    expect(ledger.release).toHaveBeenCalledOnce() // settled in finally
  })

  it('returns upstream_error when listReleases fails (null)', async () => {
    const opts = { ...baseOpts(), listReleases: vi.fn(async () => null) }
    const result = await executeInteractiveGrab({ ...opts, req: { guid: 'g', indexerId: 9 } })
    expect(result).toEqual({ status: 'upstream_error', upstreamStatus: 502 })
  })

  it('returns release_not_found when the guid+indexerId is absent', async () => {
    const result = await executeInteractiveGrab({ ...baseOpts(), req: { guid: 'ghost', indexerId: 9 } })
    expect(result).toEqual({ status: 'release_not_found' })
  })

  it('returns over_cap (no grab) when over cap and allowOverCap is not set', async () => {
    const opts = { ...baseOpts(), listReleases: vi.fn(async () => [pick(30 * GB)]) }
    const result = await executeInteractiveGrab({ ...opts, req: { guid: 'g', indexerId: 9 } })
    expect(result).toEqual({ status: 'over_cap' })
    expect(opts.postGrab).not.toHaveBeenCalled()
  })

  it('grabs over-cap when allowOverCap:true', async () => {
    const opts = { ...baseOpts(), listReleases: vi.fn(async () => [pick(30 * GB)]) }
    const result = await executeInteractiveGrab({
      ...opts,
      req: { guid: 'g', indexerId: 9, allowOverCap: true },
    })
    expect(result.status).toBe('grabbed')
    expect(opts.postGrab).toHaveBeenCalledOnce()
  })

  it('maps a non-ok upstream grab to upstream_error', async () => {
    const opts = { ...baseOpts(), postGrab: vi.fn(async () => ({ ok: false, status: 500 })) }
    const result = await executeInteractiveGrab({ ...opts, req: { guid: 'g', indexerId: 9 } })
    expect(result).toEqual({ status: 'upstream_error', upstreamStatus: 500 })
  })
})
