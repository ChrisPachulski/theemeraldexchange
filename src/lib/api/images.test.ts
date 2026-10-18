import { beforeEach, describe, expect, it, vi } from 'vitest'
import { artSrc, decodeBlurhash, mediaImage, posterImg, tmdbImage, tmdbSrcSet } from './images'

const EP = 'http://localhost/api/media/images/tmdb'

// Node env: apiUrl reads window.location.origin.
beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

describe('tmdbImage', () => {
  it('maps a bare poster_path to the server endpoint', () => {
    expect(tmdbImage('/lFf6LLrQjYldcZItzOkGmMMigP7.jpg', 342)).toBe(`${EP}/lFf6LLrQjYldcZItzOkGmMMigP7.jpg?w=342`)
  })

  it('maps a Radarr remoteUrl at any size to the same file name', () => {
    for (const size of ['original', 'w500', 'w92']) {
      expect(tmdbImage(`https://image.tmdb.org/t/p/${size}/abc123.png`, 185)).toBe(`${EP}/abc123.png?w=185`)
    }
  })

  it('gives null for a foreign host, a bad name, or nothing', () => {
    expect(tmdbImage('https://artworks.thetvdb.com/banners/p.jpg', 342)).toBeNull()
    expect(tmdbImage('https://evil.example/t/p/w342/abc.jpg', 342)).toBeNull()
    expect(tmdbImage('https://image.tmdb.org.evil.example/t/p/w342/abc.jpg', 342)).toBeNull()
    expect(tmdbImage('//image.tmdb.org/t/p/w342/abc.jpg', 342)).toBeNull()
    expect(tmdbImage('/MediaCover/1/poster.jpg', 342)).toBeNull()
    expect(tmdbImage('/../secret.jpg', 342)).toBeNull()
    expect(tmdbImage('/x.gif', 342)).toBeNull()
    expect(tmdbImage(null, 342)).toBeNull()
  })
})

describe('tmdbSrcSet', () => {
  it('lists each width as a w descriptor', () => {
    expect(tmdbSrcSet('/p.jpg', [185, 342, 500])).toBe(
      `${EP}/p.jpg?w=185 185w, ${EP}/p.jpg?w=342 342w, ${EP}/p.jpg?w=500 500w`,
    )
    expect(tmdbSrcSet('https://artworks.thetvdb.com/p.jpg', [185])).toBeUndefined()
  })
})

describe('artSrc / posterImg', () => {
  it('keeps a non-TMDB URL as is, never hotlinks TMDB', () => {
    expect(artSrc('https://artworks.thetvdb.com/p.jpg', 342)).toBe('https://artworks.thetvdb.com/p.jpg')
    expect(artSrc('https://image.tmdb.org/t/p/original/bad-name.jpg', 342)).toBeNull()
    expect(artSrc('http://IMAGE.TMDB.ORG/t/p/w92/abc.jpg', 342)).toBeNull()
    expect(artSrc(undefined, 342)).toBeNull()
  })

  it('gives TMDB posters a srcset and sizes, others only a src', () => {
    expect(posterImg('/p.jpg')).toMatchObject({ src: `${EP}/p.jpg?w=342`, srcSet: expect.stringContaining('500w'), sizes: '168px' })
    expect(posterImg('https://artworks.thetvdb.com/p.jpg')).toEqual({
      src: 'https://artworks.thetvdb.com/p.jpg',
      srcSet: undefined,
      sizes: undefined,
      style: undefined,
    })
    expect(posterImg(undefined)).toBeNull()
  })

  it('builds local artwork URLs', () => {
    expect(mediaImage('album', 7, 185)).toBe('http://localhost/api/media/images/album/7?w=185')
  })
})

describe('decodeBlurhash', () => {
  it('decodes a DC-only hash to a solid colour', () => {
    // 1x1 components, max AC 0, DC #336699.
    const px = decodeBlurhash('005?}k', 4, 3)!
    expect(px).toHaveLength(4 * 3 * 4)
    for (let o = 0; o < px.length; o += 4) expect([...px.slice(o, o + 4)]).toEqual([0x33, 0x66, 0x99, 255])
  })

  it('applies AC components: a positive red cosine is redder on the left', () => {
    // 2x1 components, max AC 0.5, DC #808080, one AC with red at +1 and green/blue at 0.
    const px = decodeBlurhash('1~Eyb[|c', 8, 1)!
    const left = px.slice(0, 4)
    const right = px.slice(7 * 4, 8 * 4)
    expect(left[0]).toBeGreaterThan(0x80)
    expect(right[0]).toBeLessThan(0x80)
    expect(left[1]).toBe(right[1])
  })

  it('decodes the reference 4x3 hash and rejects malformed ones', () => {
    expect(decodeBlurhash('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 32, 32)).toHaveLength(32 * 32 * 4)
    expect(decodeBlurhash('LEHV6nWB2yk8pyo0adR*.7kCMdn', 32, 32)).toBeNull()
    expect(decodeBlurhash('00"?}k', 4, 3)).toBeNull()
    expect(decodeBlurhash('', 4, 3)).toBeNull()
  })
})
