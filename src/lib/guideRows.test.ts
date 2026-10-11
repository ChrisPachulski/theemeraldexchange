import { describe, expect, it } from 'vitest'
import type { EpgGridDto } from './api/iptv'
import { airingNow, filterGuideRows, guideWindow } from './guideRows'

function row(stream_id: number, name: string, titles: Array<[string, string | null]> = []): EpgGridDto {
  return {
    stream_id,
    num: stream_id,
    name,
    stream_icon: null,
    epg_channel_id: null,
    tv_archive: 0,
    tv_archive_duration: null,
    programmes: titles.map(([title, description], i) => ({
      channel_id: String(stream_id),
      start_utc: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      stop_utc: new Date(Date.UTC(2026, 0, 1, i + 1)).toISOString(),
      title,
      description,
    })),
  }
}

// Ported from the Apple app's GuideSearchTests.
describe('filterGuideRows', () => {
  const rows = [
    row(101, 'US ESPN', [['SportsCenter', 'Highlights']]),
    row(102, 'US TNT', [['NBA: Celtics at Knicks', null]]),
    row(103, 'US CNN', [['Newsroom', 'Coverage of the NBA trade deadline']]),
    row(104, 'US NBA TV', []),
  ]
  const ids = (out: EpgGridDto[]) => out.map((r) => r.stream_id)

  it('keeps every row in provider order for an empty query and no favorites', () => {
    expect(ids(filterGuideRows(rows, '', new Set()))).toEqual([101, 102, 103, 104])
  })

  it('pins favorites to the top, keeping provider order within each half', () => {
    expect(ids(filterGuideRows(rows, '', new Set([104, 102])))).toEqual([102, 104, 101, 103])
  })

  it('matches channel name, number, programme title or description, case-insensitively', () => {
    expect(ids(filterGuideRows(rows, 'nba', new Set()))).toEqual([102, 103, 104])
    expect(ids(filterGuideRows(rows, '101', new Set()))).toEqual([101])
    expect(ids(filterGuideRows(rows, 'highlights', new Set()))).toEqual([101])
  })

  it('filters after pinning, so a matching favorite still leads', () => {
    expect(ids(filterGuideRows(rows, 'nba', new Set([104])))).toEqual([104, 102, 103])
  })
})

describe('guideWindow', () => {
  it('starts 30 min before the current half-hour bucket and spans 6h', () => {
    const now = Date.UTC(2026, 0, 1, 10, 47)
    const w = guideWindow(now)
    expect(w.fromIso).toBe(new Date(Date.UTC(2026, 0, 1, 10, 0)).toISOString())
    expect(w.toIso).toBe(new Date(Date.UTC(2026, 0, 1, 16, 0)).toISOString())
    // Stable within the bucket, so the grid and the mini guide share one query key.
    expect(guideWindow(Date.UTC(2026, 0, 1, 10, 31)).fromIso).toBe(w.fromIso)
  })
})

describe('airingNow', () => {
  it('returns the programme spanning now, else null', () => {
    const r = row(1, 'X', [['First', null], ['Second', null]])
    expect(airingNow(r, Date.UTC(2026, 0, 1, 1, 30))?.title).toBe('Second')
    expect(airingNow(r, Date.UTC(2026, 0, 1, 5))).toBeNull()
  })
})
