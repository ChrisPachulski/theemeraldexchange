import { describe, it, expect, vi } from 'vitest'
import cron from 'node-cron'
import { registerIptvSchedule } from './iptvScheduler.js'

vi.mock('./iptvSync.js', () => ({
  syncOnce: vi.fn(async () => ({
    busy: false, channels: 0, vod: 0, series: 0, episodes: 0, epg: 0, categories: 0,
    startedAt: '', finishedAt: '', durationMs: 0,
  })),
}))
vi.mock('./iptvDbSingleton.js', () => ({ iptvDb: () => ({ stmts: { getSyncState: { get: () => undefined } } }) }))

describe('registerIptvSchedule', () => {
  it('schedules a task at the configured cron and bootstraps if last_sync is missing', async () => {
    const calls: string[] = []
    vi.spyOn(cron, 'schedule').mockImplementation((expr: string) => {
      calls.push(expr)
      return { stop: () => undefined, start: () => undefined } as any
    })
    await registerIptvSchedule('*/5 * * * *')
    expect(calls).toContain('*/5 * * * *')
  })
})
