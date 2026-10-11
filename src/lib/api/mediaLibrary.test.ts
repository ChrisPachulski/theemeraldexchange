import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaApi } from './media'

// YouTube + Music browse clients (the library tabs). Same fetch-stub setup as
// media.test.ts: node env, so window.location.origin is synthesized.

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

const calledUrl = (i = 0) => new URL(String(fetchMock.mock.calls[i][0]))

describe('mediaApi YouTube', () => {
  it('youtubeChannels() returns the channel names in server order', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ items: [{ name: 'PBS', video_count: 2, latest_upload: '2026-10-01' }, { name: 'A+B' }] }),
    )
    expect(await mediaApi.youtubeChannels()).toEqual(['PBS', 'A+B'])
    expect(calledUrl().pathname).toBe('/api/media/youtube/channels')
  })

  it('youtubeVideos() scopes by channel (a literal + survives) and absolutizes thumbs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          {
            id: 9,
            channel: 'A+B',
            title: 'Clip',
            upload_date: '2026-10-01',
            description: 'd',
            duration_secs: 612,
            thumbUrl: '/api/media/youtube/videos/9/thumb',
          },
          { id: 10, channel: 'A+B', title: 'No thumb', upload_date: null, duration_secs: null, thumbUrl: null },
        ],
        total: 2,
      }),
    )
    const videos = await mediaApi.youtubeVideos('A+B', 24)
    const url = calledUrl()
    expect(url.pathname).toBe('/api/media/youtube/videos')
    expect(url.searchParams.get('channel')).toBe('A+B')
    expect(url.searchParams.get('limit')).toBe('24')
    expect(videos).toEqual([
      {
        id: 9,
        channel: 'A+B',
        title: 'Clip',
        uploadDate: '2026-10-01',
        durationSecs: 612,
        thumbUrl: 'http://localhost/api/media/youtube/videos/9/thumb',
      },
      { id: 10, channel: 'A+B', title: 'No thumb', uploadDate: null, durationSecs: null, thumbUrl: null },
    ])
  })

  it('youtubeVideos(null) lists across channels (no channel param)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [], total: 0 }))
    await mediaApi.youtubeVideos(null, 24)
    expect(calledUrl().searchParams.has('channel')).toBe(false)
  })
})

describe('mediaApi Music', () => {
  it('musicArtists() normalizes album_count', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [{ id: 1, name: 'Artist', album_count: 3 }], total: 1 }))
    expect(await mediaApi.musicArtists()).toEqual([{ id: 1, name: 'Artist', albumCount: 3 }])
    expect(calledUrl().pathname).toBe('/api/media/music/artists')
  })

  it('musicAlbums(artistId) sends artist_id and absolutizes art', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          { id: 7, artist_id: 1, artist_name: 'Artist', title: 'LP', year: 1999, track_count: 12, art_url: '/api/media/music/albums/7/art' },
          { id: 8, artist_id: 1, artist_name: 'Artist', title: 'EP', year: null, track_count: 1, art_url: null },
        ],
        total: 2,
      }),
    )
    const albums = await mediaApi.musicAlbums(1)
    expect(calledUrl().searchParams.get('artist_id')).toBe('1')
    expect(albums).toEqual([
      { id: 7, artistName: 'Artist', title: 'LP', year: 1999, trackCount: 12, artUrl: 'http://localhost/api/media/music/albums/7/art' },
      { id: 8, artistName: 'Artist', title: 'EP', year: null, trackCount: 1, artUrl: null },
    ])
  })

  it('musicTracks(albumId) sends album_id and pages past the 200-row cap', async () => {
    const page = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: start + i, album_id: 7, title: `t${start + i}`, track_no: start + i, duration_secs: 60 }))
    fetchMock
      .mockResolvedValueOnce(jsonRes({ items: page(0, 200), total: 201 }))
      .mockResolvedValueOnce(jsonRes({ items: page(200, 1), total: 201 }))
    const tracks = await mediaApi.musicTracks(7)
    expect(tracks).toHaveLength(201)
    expect(tracks[0]).toEqual({ id: 0, title: 't0', trackNo: 0, durationSecs: 60 })
    expect(calledUrl(0).searchParams.get('album_id')).toBe('7')
    expect(calledUrl(1).searchParams.get('album_id')).toBe('7')
    expect(calledUrl(1).searchParams.get('offset')).toBe('200')
  })
})
