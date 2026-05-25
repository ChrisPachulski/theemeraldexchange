import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { openIptvDb } from './iptvDb.js'
import {
  listCategories, listLive, listVod, listSeries, getVodDetail, getSeriesDetail,
} from './iptvCatalog.js'

describe('iptv catalog reads', () => {
  let db: ReturnType<typeof openIptvDb>
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
    const ts = '2026-05-24T00:00:00Z'
    db.stmts.upsertCategory.run({ category_id: 1, kind: 'live', name: 'News', parent_id: 0 })
    db.stmts.upsertCategory.run({ category_id: 2, kind: 'vod', name: 'Action', parent_id: 0 })
    db.stmts.upsertCategory.run({ category_id: 3, kind: 'series', name: 'Drama', parent_id: 0 })
    db.stmts.upsertChannel.run({
      stream_id: 10, num: 1, name: 'CNN', stream_icon: null, epg_channel_id: 'cnn',
      category_id: 1, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: null, fetched_at: ts,
    })
    db.stmts.upsertVod.run({
      stream_id: 20, name: 'Matrix', stream_icon: null, rating: 8.7, category_id: 2,
      container_extension: 'mp4', added_ts: null, tmdb_id: 603, year: 1999,
      plot: 'Neo', director: 'Wachowskis', cast_csv: 'Keanu', fetched_at: ts,
    })
    db.stmts.upsertSeries.run({
      series_id: 30, name: 'GoT', cover: null, plot: null, rating: 9, category_id: 3,
      tmdb_id: 1399, last_modified: null, fetched_at: ts,
    })
    db.stmts.upsertEpisode.run({
      episode_id: '101', series_id: 30, season: 1, episode_num: 1,
      title: 'Winter', container_extension: 'mp4', added_ts: null,
      plot: null, duration_secs: 3600,
    })
  })

  it('lists categories filtered by kind', () => {
    expect(listCategories(db, 'live')).toEqual([{ category_id: 1, name: 'News', parent_id: 0 }])
    expect(listCategories(db, 'vod')[0].name).toBe('Action')
  })

  it('lists live channels with paging + search', () => {
    const r = listLive(db, { limit: 50, offset: 0 })
    expect(r.total).toBe(1)
    expect(r.items[0].name).toBe('CNN')
    expect(listLive(db, { q: 'cnn' }).total).toBe(1)
    expect(listLive(db, { q: 'fox' }).total).toBe(0)
  })

  it('lists VOD and returns detail by stream_id', () => {
    expect(listVod(db, {}).total).toBe(1)
    expect(listSeries(db, {}).items[0].name).toBe('GoT')
    const v = getVodDetail(db, 20)
    expect(v?.tmdb_id).toBe(603)
    expect(v?.director).toBe('Wachowskis')
  })

  it('returns series detail with seasons + episodes', () => {
    const s = getSeriesDetail(db, 30)
    expect(s?.seasons).toHaveLength(1)
    expect(s?.seasons[0].episodes[0].title).toBe('Winter')
  })
})
