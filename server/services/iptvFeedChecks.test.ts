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
  listingsDiffer,
  NO_SIBLING_REASON,
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

function channel(db: IptvDb, stream_id: number, num: number, name: string, tvg: string | null, resolved: string | null = null): void {
  db.stmts.upsertChannel.run({
    stream_id, num, name, stream_icon: null, epg_channel_id: tvg, category_id: 123, is_adult: 0,
    tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: NOW,
  })
  db.raw.prepare('UPDATE channels SET epg_resolved_id = ? WHERE stream_id = ?').run(resolved, stream_id)
}

const siblingIds = (db: IptvDb, subject: number, epg: string): number[] =>
  feedCheckCandidates(db.raw, subject, epg, { isDead: () => false, now: Date.parse(NOW) })
    .filter((c) => c.role === 'sibling').map((c) => c.streamId)

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

  it('compares the other coast first, ahead of closer-named channels', () => {
    db.stmts.upsertChannel.run({
      stream_id: 5866, num: 5388, name: 'US Showtime West (S)', stream_icon: null, epg_channel_id: 'showtimewest.us',
      category_id: 123, is_adult: 0, tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: NOW,
    })
    db.stmts.upsertEpg.run({
      channel_id: 'showtimewest.us', start_utc: '2026-10-10T02:00:00.000Z', stop_utc: '2026-10-10T04:30:00.000Z',
      title: 'The Firm', description: null,
    })
    const list = feedCheckCandidates(db.raw, 200163566, 'showtime.us', { isDead: () => false })
    expect(list.map((c) => c.epgId)).toEqual(['showtime.us', 'showtimewest.us', 'showtime2.us', 'shoxbet.us', 'showtimeextreme.us', 'showtime.us'])
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

  it('does not rank a stream verified under an old listing as verified', () => {
    recordFeedCheck(db.raw, {
      stream_id: 22597, verdict: 'match', listed_epg_id: 'showtimeeast.us', actual_epg_id: null,
      matched_stream_id: 5864, score: 0.98,
    })
    expect(siblingIds(db, 200163566, 'showtime.us')).toEqual([5864, 22597])
  })

  it('takes as siblings only streams vouched to be the channel, not ones sharing a name-resolved id (2026-10-14)', () => {
    // WTAE Pittsburgh was "confirmed" against WPVI Philadelphia during Good
    // Morning America: both are name-resolved to abc5.us, KOCO's schedule.
    channel(db, 200168333, 1189, 'US: ABC 4 Pittsburgh (WTAE)', 'abcwtae.us', 'abc5.us')
    channel(db, 6838, 4506, 'US abc 6 (WPVI) Philadelphia (A)', 'abcwpvi.us', 'abc5.us')
    channel(db, 200168304, 1025, 'US: ABC 5 Oklahoma City (KOCO)', 'koco-dt.us_locals1', 'abc5.us')
    expect(siblingIds(db, 200168333, 'abc5.us')).toEqual([])
    // The provider's own abc5.us tag vouches; so does sharing WTAE's own tag.
    channel(db, 9001, 9, 'US ABC 5 KOCO (A)', 'abc5.us')
    channel(db, 9002, 10, 'US WTAE (A)', 'abcwtae.us', 'abc5.us')
    expect(siblingIds(db, 200168333, 'abc5.us')).toEqual([9001, 9002])
    // A West feed name-resolved to the East id is not "US: Showtime" by name.
    channel(db, 22598, 7281, 'US Showtime (West) (H)', 'showtimewest.us', 'showtime.us')
    expect(siblingIds(db, 200163566, 'showtime.us')).toEqual([5864, 22597])
  })

  it('finds siblings under an id listing the same schedule (cmt.us and cmt.hd.us2)', () => {
    channel(db, 200163492, 120, 'US: CMT', 'cmt.us')
    channel(db, 30877, 3000, 'US CMT (S)', null, 'cmt.hd.us2')
    channel(db, 107464, 3001, 'US CMT (West) (H)', null, 'cmt.hd.us2')
    channel(db, 136124, 3002, 'CA CMT (FL)', null, 'cmt.hd.us2')
    expect(siblingIds(db, 200163492, 'cmt.us')).toEqual([])
    const hour = Date.parse('2026-10-10T03:00:00.000Z')
    for (let h = -13; h <= 13; h++) {
      for (const id of ['cmt.us', 'cmt.hd.us2']) {
        db.stmts.upsertEpg.run({
          channel_id: id, start_utc: new Date(hour + h * 3600_000).toISOString(),
          stop_utc: new Date(hour + (h + 1) * 3600_000).toISOString(),
          title: `${id === 'cmt.us' ? 'Live: ' : ''}Show ${(h + 13) % 6}`, description: null,
        })
      }
    }
    // Same name, same coast: the CMT (S) stream only.
    expect(siblingIds(db, 200163492, 'cmt.us')).toEqual([30877])
  })

  it('compares listings by programme, not spelling, and ignores placeholders (Willow, KOCO, Bay Area Plus)', () => {
    const differ = (a: string, b: string): boolean => {
      for (const [channel_id, title] of [['a.us', a], ['b.us', b]]) {
        db.stmts.upsertEpg.run({
          channel_id, start_utc: '2026-10-10T02:00:00.000Z', stop_utc: '2026-10-10T04:30:00.000Z', title, description: null,
        })
      }
      return listingsDiffer(db.raw, 'a.us', 'b.us', new Date(NOW))
    }
    expect(differ('T20 Cricket', 'T20 Cricket : India vs. West Indies')).toBe(false)
    expect(differ('Good Morning America Category: News/Public affairs/Talk/Variety/Series', 'Good Morning America')).toBe(false)
    expect(differ('Live: WWE NXT', 'WWE NXT')).toBe(false)
    expect(differ('College Football : Florida at Texas', 'College Football : Washington at Purdue')).toBe(true)
    expect(differ("Men's Health - All-Natural Secret for Prostate Health", 'SIGN OFF')).toBe(false)
    expect(differ('Paid Programming', 'Next game: Chicago Bears at Atlanta Falcons at 10/18/2026 01:00 PM (US/Eastern)')).toBe(false)
    // EPIX HITS on epix.us is still caught.
    expect(differ('The Last Samurai', 'Transformers One')).toBe(true)
  })

  it('knows what a fresh verdict says the stream carries', () => {
    mislabel(db, new Date(NOW))
    const check = getFeedCheck(db.raw, 200163566)!
    expect(knownCarriedEpgId(check, 'showtime.us')).toBe('showtime2.us')
    expect(knownCarriedEpgId(check, 'showtimeshowcase.us')).toBeNull()
    expect(feedCheckIsFresh(check, 'showtime.us', Date.parse(NOW) + 23 * 3600_000)).toBe(true)
    expect(feedCheckIsFresh(check, 'showtime.us', Date.parse(NOW) + 25 * 3600_000)).toBe(false)
    // A verdict about another listing is no verdict on the stream as listed now.
    expect(feedCheckIsFresh(check, 'showtimeshowcase.us', Date.parse(NOW) + 3600_000)).toBe(false)
  })

  it('retries a check that compared nothing a day and an hour later, so the next try is at another hour', () => {
    const inconclusive = (reason: string | null): void => recordFeedCheck(db.raw, {
      stream_id: 200163566, verdict: 'inconclusive', listed_epg_id: 'showtime.us', actual_epg_id: null,
      matched_stream_id: null, score: null, reason,
    }, new Date(NOW))
    const freshAt = (hours: number): boolean =>
      feedCheckIsFresh(getFeedCheck(db.raw, 200163566)!, 'showtime.us', Date.parse(NOW) + hours * 3600_000)
    inconclusive('subject capture failed')
    expect(getFeedCheck(db.raw, 200163566)?.reason).toBe('subject capture failed')
    expect(freshAt(24.5)).toBe(true)
    expect(freshAt(25.5)).toBe(false)
    // Nothing to compare (no connection opened) and pre-0009 rows keep 6 hours.
    inconclusive(NO_SIBLING_REASON)
    expect(freshAt(6.5)).toBe(false)
    inconclusive(null)
    expect(freshAt(6.5)).toBe(false)
  })
})
