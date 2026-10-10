import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { epgGrid, epgNow } from './iptvEpgQuery.js'
import { resolveSiblingFeeds } from './iptvSiblingFeeds.js'
import {
  effectiveEpgId,
  epgIdFamily,
  feedCheckCandidates,
  feedCheckIsFresh,
  getFeedCheck,
  knownCarriedEpgId,
  recordFeedCheck,
  relatedEpgIds,
} from './iptvFeedChecks.js'

// The 2026-10-09 incident, in miniature: four Showtime streams from three
// provider sources, two Showtime 2 streams, and an unrelated channel.
const CHANNELS: Array<[number, number, string, string | null]> = [
  [200163566, 154, 'US: Showtime', 'showtime.us'],
  [200163567, 204, 'US: Showtime 2', 'showtime2.us'],
  [5864, 5386, 'US Showtime East (S)', 'showtime.us'],
  [22597, 7280, 'US Showtime (East) (H)', 'showtime.us'],
  [22599, 7357, 'US Showtime 2 (East) (H)', 'showtime2.us'],
  [200163569, 225, 'US: Showtime Extreme', 'showtimeextreme.us'],
  [200163568, 419, 'US: SHOxBET', 'shoxbet.us'],
  [900, 1, 'CNN', 'cnn.us'],
]
const NOW = '2026-10-10T03:08:00.000Z'

function seed(db: IptvDb): void {
  for (const [stream_id, num, name, epg_channel_id] of CHANNELS) {
    db.stmts.upsertChannel.run({
      stream_id, num, name, stream_icon: null, epg_channel_id, category_id: 123, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: NOW,
    })
  }
  const programme = (channel_id: string, title: string): void => {
    db.stmts.upsertEpg.run({
      channel_id, start_utc: '2026-10-10T02:00:00.000Z', stop_utc: '2026-10-10T04:30:00.000Z', title, description: null,
    })
  }
  programme('showtime.us', 'My Cousin Vinny')
  programme('showtime2.us', 'Blade Runner 2049')
  programme('showtimeextreme.us', 'Heat')
  programme('shoxbet.us', 'Friday')
  programme('cnn.us', 'News')
}

function mislabel(db: IptvDb, at = new Date(NOW)): void {
  recordFeedCheck(db.raw, {
    stream_id: 200163566, verdict: 'mislabeled', listed_epg_id: 'showtime.us', actual_epg_id: 'showtime2.us',
    matched_stream_id: 22599, score: 0.97,
  }, at)
}

describe('feed checks', () => {
  let db: IptvDb

  beforeEach(() => {
    db = openIptvDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feedchk-')), 'iptv.db'))
    seed(db)
  })

  it('relates channels of one brand, and only those', () => {
    expect(epgIdFamily('showtime2west.us')).toEqual({ base: 'showtime2west', root: 'showtime', country: 'us' })
    expect(relatedEpgIds('showtime.us', 'showtime2.us')).toBe(true)
    expect(relatedEpgIds('showtime.us', 'showtimeextreme.us')).toBe(true)
    expect(relatedEpgIds('hbozone.us', 'hbocomedy.us')).toBe(true)
    expect(relatedEpgIds('showtime.us', 'shoxbet.us')).toBe(true) // SHOxBET is a Showtime channel
    expect(relatedEpgIds('showtime.us', 'starz.us')).toBe(false)
    expect(relatedEpgIds('cnn.us', 'cnbc.us')).toBe(false)
    expect(relatedEpgIds('showtime.us', 'showtime.ca')).toBe(false)
    expect(relatedEpgIds('showtime.us', 'showtime.us')).toBe(false)
  })

  it('lists a mislabeled stream with the programmes it really carries', () => {
    const before = epgNow(db, [200163566], new Date(NOW))
    expect(before[0].current?.title).toBe('My Cousin Vinny')

    mislabel(db)
    expect(effectiveEpgId(db.raw, 200163566)).toBe('showtime2.us')
    expect(epgNow(db, [200163566], new Date(NOW))[0].current?.title).toBe('Blade Runner 2049')
    const grid = epgGrid(db, '2026-10-10T02:00:00.000Z', '2026-10-10T04:00:00.000Z', { hasEpgOnly: true })
    expect(grid.find((r) => r.stream_id === 200163566)?.programmes.map((p) => p.title)).toEqual(['Blade Runner 2049'])
    // The other Showtime streams keep their own listing.
    expect(grid.find((r) => r.stream_id === 5864)?.programmes.map((p) => p.title)).toEqual(['My Cousin Vinny'])
  })

  it('drops the override once the provider re-maps the stream', () => {
    mislabel(db)
    db.raw.prepare('UPDATE channels SET epg_channel_id = ? WHERE stream_id = ?').run('showtimeshowcase.us', 200163566)
    expect(effectiveEpgId(db.raw, 200163566)).toBe('showtimeshowcase.us')
  })

  it('moves a mislabeled stream to the failover list of the channel it carries', () => {
    expect(resolveSiblingFeeds(db.raw, '5864')).toContain('200163566')
    mislabel(db)
    expect(resolveSiblingFeeds(db.raw, '5864')).not.toContain('200163566')
    expect(resolveSiblingFeeds(db.raw, '22599')).toContain('200163566')
  })

  it('orders candidates: another source of the listing, related channels by closeness, a second sibling last', () => {
    const list = feedCheckCandidates(db.raw, 200163566, 'showtime.us', { isDead: () => false })
    expect(list).toEqual([
      { streamId: 5864, epgId: 'showtime.us', role: 'sibling' },
      { streamId: 22599, epgId: 'showtime2.us', role: 'family' },
      { streamId: 200163568, epgId: 'shoxbet.us', role: 'family' },
      { streamId: 200163569, epgId: 'showtimeextreme.us', role: 'family' },
      { streamId: 22597, epgId: 'showtime.us', role: 'sibling' },
    ])
  })

  it('prefers a verified stream and skips dead or excluded ones', () => {
    recordFeedCheck(db.raw, {
      stream_id: 22597, verdict: 'match', listed_epg_id: 'showtime.us', actual_epg_id: null,
      matched_stream_id: 5864, score: 0.98,
    })
    const list = feedCheckCandidates(db.raw, 200163566, 'showtime.us', {
      isDead: (id) => id === 22599,
      exclude: [200163569],
    })
    expect(list.map((c) => c.streamId)).toEqual([22597, 200163567, 200163568, 5864])
  })

  it('knows what a fresh verdict says the stream carries', () => {
    mislabel(db, new Date(NOW))
    const check = getFeedCheck(db.raw, 200163566)!
    expect(knownCarriedEpgId(check, 'showtime.us')).toBe('showtime2.us')
    expect(knownCarriedEpgId(check, 'showtimeshowcase.us')).toBeNull()
    expect(feedCheckIsFresh(check, Date.parse(NOW) + 23 * 3600_000)).toBe(true)
    expect(feedCheckIsFresh(check, Date.parse(NOW) + 25 * 3600_000)).toBe(false)
  })
})
