import { describe, it, expect } from 'vitest'
import { buildPlexDeepLink, buildPlexSearchLink, resolvePlexLink, type LinkMap } from './usePlexLinks'

const EMPTY_MAP: LinkMap = {
  movie: { byTmdb: {}, byTvdb: {}, byImdb: {} },
  tv: { byTmdb: {}, byTvdb: {}, byImdb: {} },
}

// Pure-URL tests for the Plex deep-link builders. The Plex web client
// expects: `/web/index.html#!/server/<serverId>/details?key=<url-encoded /library/metadata/...>`
// for the deep link, and `/web/index.html#!/search?query=<encoded>` for
// the search fallback. Get either format wrong and the link silently
// lands on Plex's home screen instead of the title — household members
// think the overlay is broken without any visible error.

describe('buildPlexDeepLink', () => {
  it('builds the metadata-page deep link with a URL-encoded key', () => {
    const url = buildPlexDeepLink('abc123', '42')
    expect(url).toBe(
      'http://theemeraldexchange.local:32400/web/index.html#!/server/abc123/details?key=%2Flibrary%2Fmetadata%2F42',
    )
  })

  it('falls back to the Plex root URL when serverId is null (PLEX_SERVER_ID unset)', () => {
    const url = buildPlexDeepLink(null, '42')
    expect(url).toBe('http://theemeraldexchange.local:32400/web')
  })

  it('handles ratingKeys with non-ASCII characters (Plex theoretically returns string ids)', () => {
    const url = buildPlexDeepLink('abc', 'rkñ')
    expect(url).toContain('details?key=')
    expect(url).toContain(encodeURIComponent('/library/metadata/rkñ'))
  })

  it('places the server id in the hash route segment, not the query', () => {
    const url = buildPlexDeepLink('SERVER_ID_HERE', '101')
    expect(url).toMatch(/#!\/server\/SERVER_ID_HERE\/details\?key=/)
  })
})

describe('buildPlexSearchLink', () => {
  it('URL-encodes the query into Plex web search hash route', () => {
    expect(buildPlexSearchLink('The 100')).toBe(
      'http://theemeraldexchange.local:32400/web/index.html#!/search?query=The%20100',
    )
  })

  it('encodes punctuation and unicode safely', () => {
    const url = buildPlexSearchLink("Pokémon: Detective Pikachu & Friends")
    expect(url).toContain('#!/search?query=')
    const q = new URL(url.replace('#!', '#')).hash.split('?query=')[1]
    expect(decodeURIComponent(q)).toBe("Pokémon: Detective Pikachu & Friends")
  })
})

// The fallback chain — tmdb → tvdb → imdb → search-by-title — is the
// whole point of this resolver. If any link breaks, household members
// with a legacy Plex agent (tvdb-only GUIDs) or a freshly-added title
// (no GUIDs yet) lose the play overlay. These tests pin the order.
describe('resolvePlexLink — id fallback chain', () => {
  it('prefers tmdb when present (matches the Plex Movie agent default)', () => {
    const map: LinkMap = {
      ...EMPTY_MAP,
      tv: { byTmdb: { '95396': 'TMDB-WIN' }, byTvdb: { '371980': 'TVDB-LOSE' }, byImdb: {} },
    }
    const url = resolvePlexLink(map, 'srv', 'tv', { tmdbId: 95396, tvdbId: 371980 })
    expect(url).toContain('details?key=')
    expect(url).toContain(encodeURIComponent('/library/metadata/TMDB-WIN'))
  })

  it('falls back to tvdb when tmdb misses (legacy Plex TV Series agent path)', () => {
    // Regression case for "The 100" — library scanned with the legacy
    // agent emits only tvdb GUIDs, so byTmdb is empty for TV.
    const map: LinkMap = {
      ...EMPTY_MAP,
      tv: { byTmdb: {}, byTvdb: { '121361': 'TVDB-HIT' }, byImdb: {} },
    }
    const url = resolvePlexLink(map, 'srv', 'tv', { tmdbId: 99999, tvdbId: 121361, title: 'The 100' })
    expect(url).toContain(encodeURIComponent('/library/metadata/TVDB-HIT'))
  })

  it('falls back to imdb when both tmdb and tvdb miss', () => {
    const map: LinkMap = {
      ...EMPTY_MAP,
      movie: { byTmdb: {}, byTvdb: {}, byImdb: { tt1375666: 'IMDB-HIT' } },
    }
    const url = resolvePlexLink(map, 'srv', 'movie', { tmdbId: 27205, imdbId: 'tt1375666' })
    expect(url).toContain(encodeURIComponent('/library/metadata/IMDB-HIT'))
  })

  it('falls back to Plex search when no id resolves but title is given', () => {
    const url = resolvePlexLink(EMPTY_MAP, 'srv', 'tv', { tmdbId: 1, title: 'Unmatched Show' })
    expect(url).toBe(
      'http://theemeraldexchange.local:32400/web/index.html#!/search?query=Unmatched%20Show',
    )
  })

  it('falls back to search even when the library-links map is null (server unreachable)', () => {
    // 502 plex_unreachable yields a null map client-side. The overlay
    // must still render — search fallback is the degraded mode.
    const url = resolvePlexLink(null, 'srv', 'movie', { tmdbId: 1, title: 'Anything' })
    expect(url).toContain('#!/search?query=Anything')
  })

  it('returns null when nothing matches and no title is given', () => {
    expect(resolvePlexLink(EMPTY_MAP, 'srv', 'movie', { tmdbId: 1 })).toBeNull()
    expect(resolvePlexLink(EMPTY_MAP, 'srv', 'tv', {})).toBeNull()
  })

  it('serializes numeric tmdbId to the string key Plex returned', () => {
    const map: LinkMap = {
      ...EMPTY_MAP,
      movie: { byTmdb: { '27205': 'rk' }, byTvdb: {}, byImdb: {} },
    }
    expect(resolvePlexLink(map, 'srv', 'movie', { tmdbId: 27205 })).toContain('rk')
    expect(resolvePlexLink(map, 'srv', 'movie', { tmdbId: '27205' })).toContain('rk')
  })
})
