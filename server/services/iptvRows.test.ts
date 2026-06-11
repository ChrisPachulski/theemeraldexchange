import { describe, it, expect } from 'vitest'
import {
  rowMapper,
  mapRows,
  channelM3uRow,
  playlistTokenRow,
  channelArchiveRow,
  nameRow,
} from './iptvRows.js'

describe('rowMapper', () => {
  const mapper = rowMapper({
    id: 'number',
    name: 'string',
    note: 'string|null',
    count: 'number|null',
  })

  it('maps a conforming row through unchanged', () => {
    expect(mapper({ id: 1, name: 'a', note: 'n', count: 2 })).toEqual({
      id: 1,
      name: 'a',
      note: 'n',
      count: 2,
    })
  })

  it('normalises absent/undefined nullable columns to null', () => {
    expect(mapper({ id: 1, name: 'a' })).toEqual({ id: 1, name: 'a', note: null, count: null })
  })

  it('rejects a missing required column', () => {
    expect(mapper({ name: 'a' })).toBeNull()
  })

  it('rejects a type drift (number column came back as string)', () => {
    expect(mapper({ id: '1', name: 'a' })).toBeNull()
  })

  it('rejects non-object rows (undefined .get() result, null, scalars)', () => {
    expect(mapper(undefined)).toBeNull()
    expect(mapper(null)).toBeNull()
    expect(mapper(42)).toBeNull()
    expect(mapper('row')).toBeNull()
  })

  it('mapRows drops invalid rows and keeps the rest in order', () => {
    const rows = [
      { id: 1, name: 'a' },
      { id: 'bad', name: 'b' },
      { id: 3, name: 'c' },
    ]
    expect(mapRows(mapper, rows).map((r) => r.id)).toEqual([1, 3])
  })
})

describe('shared IPTV row shapes', () => {
  it('channelM3uRow accepts a real-shaped channels row', () => {
    expect(
      channelM3uRow({
        stream_id: 10,
        num: 1,
        name: 'CNN',
        stream_icon: null,
        epg_channel_id: 'cnn.us',
        category_id: 1,
      }),
    ).not.toBeNull()
  })

  it('playlistTokenRow rejects a row missing its jti', () => {
    expect(
      playlistTokenRow({
        sub: 'plex:42',
        device_name: null,
        issued_at: 'x',
        expires_at: 'y',
        revoked_at: null,
      }),
    ).toBeNull()
  })

  it('channelArchiveRow tolerates a null archive duration', () => {
    expect(channelArchiveRow({ tv_archive: 1, tv_archive_duration: null })).toEqual({
      tv_archive: 1,
      tv_archive_duration: null,
    })
  })

  it('nameRow rejects a non-string name (schema drift guard)', () => {
    expect(nameRow({ name: 7 })).toBeNull()
  })
})
