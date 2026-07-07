import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { epgChannelWindow, epgGrid, epgNow, epgSearch } from './iptvEpgQuery.js'

describe('epg queries', () => {
  let db: IptvDb

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
    const fetchedAt = '2026-05-24T12:00:00Z'

    db.stmts.upsertChannel.run({
      stream_id: 10,
      num: 1,
      name: 'C1',
      stream_icon: 'https://logos.example/c1.png',
      epg_channel_id: 'c1',
      category_id: 1,
      is_adult: 0,
      tv_archive: 1,
      tv_archive_duration: 7,
      added_ts: null,
      fetched_at: fetchedAt,
    })
    db.stmts.upsertChannel.run({
      stream_id: 20,
      num: 2,
      name: 'C2',
      stream_icon: null,
      epg_channel_id: 'c2',
      category_id: 2,
      is_adult: 0,
      tv_archive: 0,
      tv_archive_duration: null,
      added_ts: null,
      fetched_at: fetchedAt,
    })
    db.stmts.upsertChannel.run({
      stream_id: 30,
      num: 3,
      name: 'No EPG',
      stream_icon: null,
      epg_channel_id: null,
      category_id: 1,
      is_adult: 0,
      tv_archive: 0,
      tv_archive_duration: null,
      added_ts: null,
      fetched_at: fetchedAt,
    })

    db.stmts.upsertEpg.run({
      channel_id: 'c1',
      start_utc: '2026-05-24T11:00:00Z',
      stop_utc: '2026-05-24T11:30:00Z',
      title: 'Past',
      description: null,
    })
    db.stmts.upsertEpg.run({
      channel_id: 'c1',
      start_utc: '2026-05-24T11:30:00Z',
      stop_utc: '2026-05-24T12:30:00Z',
      title: 'Now',
      description: 'Current show',
    })
    db.stmts.upsertEpg.run({
      channel_id: 'c1',
      start_utc: '2026-05-24T12:30:00Z',
      stop_utc: '2026-05-24T13:00:00Z',
      title: 'Next',
      description: null,
    })
    db.stmts.upsertEpg.run({
      channel_id: 'c2',
      start_utc: '2026-05-24T12:00:00Z',
      stop_utc: '2026-05-24T13:00:00Z',
      title: 'Other Channel',
      description: null,
    })
  })

  afterEach(() => {
    db.close()
  })

  it('epgNow returns current and next programmes for each channel', () => {
    const rows = epgNow(db, [10, 30], new Date('2026-05-24T12:00:00Z'))

    expect(rows).toEqual([
      expect.objectContaining({
        channel_stream_id: 10,
        current: expect.objectContaining({ title: 'Now' }),
        next: expect.objectContaining({ title: 'Next' }),
      }),
      { channel_stream_id: 30, current: null, next: null },
    ])
  })

  it('epgChannelWindow returns programmes overlapping the requested range', () => {
    const rows = epgChannelWindow(db, 10, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')

    expect(rows.map((row) => row.title)).toEqual(['Past', 'Now', 'Next'])
  })

  it('epgGrid maps channels with programmes', () => {
    const rows = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')

    expect(rows[0]).toEqual(expect.objectContaining({
      stream_id: 10,
      name: 'C1',
      stream_icon: 'https://logos.example/c1.png',
      tv_archive: 1,
      tv_archive_duration: 7,
    }))
    expect(rows[0].programmes.map((row) => row.title)).toEqual(['Past', 'Now', 'Next'])
  })

  it('epgGrid can filter by category', () => {
    const rows = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', 2)

    expect(rows).toHaveLength(1)
    expect(rows[0].stream_id).toBe(20)
    expect(rows[0].programmes.map((row) => row.title)).toEqual(['Other Channel'])
  })

  it('epgGrid filters by a set of categoryIds (IN-list, precedence over single)', () => {
    // [1, 2] spans every seeded channel; [2] alone is just stream 20.
    const both = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', { categoryIds: [1, 2] })
    expect(both.map((r) => r.stream_id).sort()).toEqual([10, 20, 30])

    const one = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', { categoryIds: [2] })
    expect(one.map((r) => r.stream_id)).toEqual([20])

    // categoryIds wins when both are supplied.
    const wins = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', { categoryId: 1, categoryIds: [2] })
    expect(wins.map((r) => r.stream_id)).toEqual([20])
  })

  it('epgGrid hasEpgOnly drops channels without programmes in the window', () => {
    // C1 + C2 have programmes; "No EPG" (stream 30, null tvg-id) does not.
    const all = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')
    expect(all.map((r) => r.stream_id)).toEqual([10, 20, 30])

    const scoped = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', { hasEpgOnly: true })
    expect(scoped.map((r) => r.stream_id)).toEqual([10, 20])
  })

  it('epgGrid filters by channel-name query', () => {
    const rows = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', { q: 'C1' })
    expect(rows.map((r) => r.stream_id)).toEqual([10])
  })

  it('epgGrid returns no rows when hasEpgOnly and the window is empty', () => {
    const rows = epgGrid(db, '2020-01-01T00:00:00Z', '2020-01-01T01:00:00Z', { hasEpgOnly: true })
    expect(rows).toEqual([])
  })
})

describe('epg grid query plan (perf regression guard)', () => {
  // Mirrors the programmes scan inside epgGrid() (iptvEpgQuery.ts): a
  // window-only filter over epg_programs with NO channel predicate. Without
  // sqlite_stat1 the planner has no selectivity estimate and full-SCANs this
  // ~10^5–10^6-row table on the synchronous better-sqlite3 driver — on the same
  // event loop that proxies live segments. syncOnce() now runs PRAGMA optimize
  // after populating the table so the planner range-SEARCHes the
  // (channel_id, start_utc) primary-key index instead (which also serves the
  // ORDER BY channel_id for free). This test pins that invariant: a future
  // change that drops the stats step or rewrites the query back into a full
  // scan fails here. (If this SQL drifts from epgGrid()'s, update both.)
  const GRID_PROGRAMMES_SQL = `
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE start_utc < ? AND stop_utc > ?
    ORDER BY channel_id, start_utc ASC
  `
  let dir: string
  let db: IptvDb
  let fromIso: string
  let toIso: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-plan-'))
    db = openIptvDb(path.join(dir, 'iptv.db'))
    // Prod-shaped retention window [now-24h, now+7d]: mostly future rows across
    // many channels — the distribution under which the planner's index choice
    // matters and an index without stats would be skipped.
    const now = Date.now()
    const DAY = 86_400_000
    const past = now - DAY
    const span = 8 * DAY
    const CHANNELS = 300
    const PROGS = 30
    const slot = span / PROGS
    const seed = db.raw.transaction(() => {
      for (let c = 0; c < CHANNELS; c++) {
        const cid = `c${c}`
        for (let p = 0; p < PROGS; p++) {
          const start = past + p * slot
          db.stmts.upsertEpg.run({
            channel_id: cid,
            start_utc: new Date(start).toISOString(),
            stop_utc: new Date(start + slot).toISOString(),
            title: 'T',
            description: 'D',
          })
        }
      }
    })
    seed()
    fromIso = new Date(now).toISOString()
    toIso = new Date(now + 4 * 3_600_000).toISOString()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const planFor = (): string =>
    (
      db.raw.prepare(`EXPLAIN QUERY PLAN ${GRID_PROGRAMMES_SQL}`).all(toIso, fromIso) as Array<{
        detail: string
      }>
    )
      .map((r) => r.detail)
      .join(' | ')

  it('full-SCANs epg_programs before statistics exist', () => {
    // Baseline: a freshly-opened DB has no sqlite_stat1, so the guide query
    // degrades to a full table scan — the problem this fix addresses.
    expect(planFor()).toContain('SCAN epg_programs')
  })

  it('range-SEARCHes epg_programs after the sync runs PRAGMA optimize', () => {
    db.raw.pragma('optimize')
    const plan = planFor()
    expect(plan).toContain('SEARCH epg_programs')
    expect(plan).not.toContain('SCAN epg_programs')
  })
})

describe('epgSearch pushes the filter into SQLite (does not materialize the whole window)', () => {
  let dir: string
  let db: IptvDb
  let fromIso: string
  let toIso: string
  const CHANNELS = 200
  const PROGS = 300 // 60k window rows total — stark vs. a handful of matches

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-search-'))
    db = openIptvDb(path.join(dir, 'iptv.db'))
    const now = Date.now()
    const DAY = 86_400_000
    const past = now - DAY
    const span = 8 * DAY
    const slot = span / PROGS
    const seed = db.raw.transaction(() => {
      for (let c = 0; c < CHANNELS; c++) {
        const cid = `c${c}`
        db.stmts.upsertChannel.run({
          stream_id: c + 1,
          num: c + 1,
          name: `Channel ${c}`,
          stream_icon: null,
          epg_channel_id: cid,
          category_id: 1,
          is_adult: 0,
          tv_archive: 0,
          tv_archive_duration: null,
          added_ts: null,
          fetched_at: new Date(now).toISOString(),
        })
        for (let p = 0; p < PROGS; p++) {
          const start = past + p * slot
          // Only channel c5 carries the needle, at two KNOWN indices — every other
          // programme is generic filler the SQL filter must skip inside the engine.
          db.stmts.upsertEpg.run({
            channel_id: cid,
            start_utc: new Date(start).toISOString(),
            stop_utc: new Date(start + slot).toISOString(),
            title: c === 5 && p === 7 ? 'Evening News' : 'Filler Show',
            description: c === 5 && p === 20 ? 'Breaking news at ten' : 'nothing to see',
          })
        }
      }
    })
    seed()
    db.raw.pragma('optimize')
    // A window wide enough that ALL 60k programmes overlap it — so the OLD code
    // would materialize the entire store, and the fix's win is unambiguous.
    fromIso = new Date(past).toISOString()
    toIso = new Date(now + 8 * DAY).toISOString()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns exactly the matched programmes with grid-aligned programIndex', () => {
    const { hits, total } = epgSearch(db, fromIso, toIso, { q: 'news' })
    expect(total).toBe(2)
    expect(hits).toHaveLength(2)
    // programIndex is the hit's position within channel c5's window-ordered list
    // (0-based) — must match the grid's `row.programmes` index (7 and 20).
    expect(hits.map((h) => h.programIndex).sort((a, b) => a - b)).toEqual([7, 20])
    for (const h of hits) {
      expect(h.streamId).toBe(6) // c5 → stream_id 6
      expect(h.channelName).toBe('Channel 5')
    }
    // Case-insensitive: the title hit is 'News', the description hit is 'news'.
    expect(hits.some((h) => h.programme.title === 'Evening News')).toBe(true)
    expect(hits.some((h) => h.programme.description === 'Breaking news at ten')).toBe(true)
  })

  it('a LIKE metacharacter in the term is matched literally, not as a wildcard', () => {
    // '%' would match everything if unescaped; escaped it matches nothing here.
    expect(epgSearch(db, fromIso, toIso, { q: '%' }).total).toBe(0)
  })

  it('materializes only the match set into JS, not the full window', () => {
    // Spy every prepared statement's .all() and record the largest row batch it
    // hands back to JS. The OLD implementation's first query returned the entire
    // window (~60k rows); the fix returns only matched rows + matched channels.
    let maxRowsToJs = 0
    const origPrepare = db.raw.prepare.bind(db.raw)
    const spy = vi.spyOn(db.raw, 'prepare').mockImplementation(((sql: string) => {
      const stmt = origPrepare(sql)
      const origAll = stmt.all.bind(stmt)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(stmt as any).all = (...args: unknown[]) => {
        const rows = origAll(...(args as [])) as unknown[]
        if (Array.isArray(rows)) maxRowsToJs = Math.max(maxRowsToJs, rows.length)
        return rows
      }
      return stmt
    }) as unknown as typeof db.raw.prepare)
    try {
      const { total } = epgSearch(db, fromIso, toIso, { q: 'news' })
      expect(total).toBe(2)
    } finally {
      spy.mockRestore()
    }
    // Red on the old full-materialization code: maxRowsToJs ≈ 60_000. Green now:
    // the SQL LIKE returns just the 2 matches + the 1 matched-channel row.
    expect(maxRowsToJs).toBeLessThan(1_000)
  })
})
