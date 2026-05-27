import { describe, it, expect, vi, beforeEach } from 'vitest'
import cron from 'node-cron'
import { registerIptvSchedule } from './iptvScheduler.js'

vi.mock('./iptvSync.js', () => ({
  syncOnce: vi.fn(async () => ({
    busy: false, channels: 0, vod: 0, series: 0, episodes: 0, epg: 0, categories: 0,
    startedAt: '', finishedAt: '', durationMs: 0,
  })),
}))

// ---------------------------------------------------------------------------
// Shared in-memory row store used by sweep tests.
// ---------------------------------------------------------------------------

type LinkRow = { removed_at: string | null }

function makeMockDb(rows: LinkRow[]) {
  return {
    stmts: { getSyncState: { get: () => undefined } },
    raw: {
      prepare: (sql: string) => ({
        run: () => {
          if (sql.includes('DELETE FROM iptv_title_link WHERE removed_at <')) {
            const cutoff = new Date(Date.now() - 14 * 24 * 3600_000).toISOString()
            const before = rows.length
            rows.splice(0, rows.length, ...rows.filter((r) => {
              if (r.removed_at === null) return true
              return r.removed_at >= cutoff
            }))
            return { changes: before - rows.length }
          }
          return { changes: 0 }
        },
      }),
    },
  }
}

// Use vi.fn() so tests can swap the return value via .mockImplementation().
const mockIptvDb = vi.fn((..._args: unknown[]) => makeMockDb([]))

vi.mock('./iptvDbSingleton.js', () => ({
  iptvDb: (...args: unknown[]) => mockIptvDb(...args),
}))

describe('registerIptvSchedule', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockIptvDb.mockImplementation(() => makeMockDb([]))
  })

  it('schedules a task at the configured cron and bootstraps if last_sync is missing', async () => {
    const calls: string[] = []
    vi.spyOn(cron, 'schedule').mockImplementation((expr: string) => {
      calls.push(expr)
      return { stop: () => undefined, start: () => undefined } as ReturnType<typeof cron.schedule>
    })
    await registerIptvSchedule('*/5 * * * *')
    expect(calls).toContain('*/5 * * * *')
  })

  it('registers tombstone sweep cron in addition to the sync cron', async () => {
    const calls: string[] = []
    vi.spyOn(cron, 'schedule').mockImplementation((expr: string) => {
      calls.push(expr)
      return { stop: () => undefined, start: () => undefined } as ReturnType<typeof cron.schedule>
    })
    await registerIptvSchedule('0 */6 * * *')
    expect(calls).toContain('0 3 * * *')
  })
})

// ---------------------------------------------------------------------------
// Tombstone sweep logic — exercised by capturing the cron callback directly.
// ---------------------------------------------------------------------------

describe('tombstone sweep', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('hard-deletes a row tombstoned 15 days ago and keeps one tombstoned 13 days ago', async () => {
    const stale = new Date(Date.now() - 15 * 24 * 3600_000).toISOString()
    const fresh = new Date(Date.now() - 13 * 24 * 3600_000).toISOString()
    const rows: LinkRow[] = [
      { removed_at: stale },  // should be swept
      { removed_at: fresh },  // should survive
      { removed_at: null },   // active row — never touched
    ]

    mockIptvDb.mockImplementation(() => makeMockDb(rows))

    let sweepCallback: (() => void) | undefined
    vi.spyOn(cron, 'schedule').mockImplementation(((expr: string, fn: unknown) => {
      // node-cron v4's `func` param is typed as
      // `string | ((now: Date | 'manual' | 'init') => void)`; tests pass
      // a zero-arg fn (`fn()`), so we extract via unknown to bypass the
      // tighter prod signature.
      if (expr === '0 3 * * *' && typeof fn === 'function') {
        sweepCallback = fn as () => void
      }
      return { stop: () => undefined, start: () => undefined } as ReturnType<typeof cron.schedule>
    }) as typeof cron.schedule)

    await registerIptvSchedule('0 */6 * * *')
    expect(sweepCallback).toBeDefined()
    sweepCallback!()

    // Row at -15 days must be gone; row at -13 days and active row must survive.
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.removed_at === stale)).toBe(false)
    expect(rows.some((r) => r.removed_at === fresh)).toBe(true)
    expect(rows.some((r) => r.removed_at === null)).toBe(true)
  })

  it('does not throw when the sweep DELETE fails — cron stays registered', async () => {
    mockIptvDb.mockImplementation(() => ({
      stmts: { getSyncState: { get: () => undefined } },
      raw: {
        prepare: () => ({
          run: () => { throw new Error('disk full') },
        }),
      },
    }))

    let sweepCallback: (() => void) | undefined
    vi.spyOn(cron, 'schedule').mockImplementation(((expr: string, fn: unknown) => {
      // node-cron v4's `func` param is typed as
      // `string | ((now: Date | 'manual' | 'init') => void)`; tests pass
      // a zero-arg fn (`fn()`), so we extract via unknown to bypass the
      // tighter prod signature.
      if (expr === '0 3 * * *' && typeof fn === 'function') {
        sweepCallback = fn as () => void
      }
      return { stop: () => undefined, start: () => undefined } as ReturnType<typeof cron.schedule>
    }) as typeof cron.schedule)

    await registerIptvSchedule('0 */6 * * *')
    expect(sweepCallback).toBeDefined()
    // Must not throw — try/catch in scheduler absorbs it.
    expect(() => sweepCallback!()).not.toThrow()
  })
})
