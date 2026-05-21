import { describe, it, expect } from 'vitest'
import { buildPlexDeepLink } from './usePlexLinks'

// Pure-URL tests for the Plex deep-link builder. The Plex web client
// expects: `/web/index.html#!/server/<serverId>/details?key=<url-encoded /library/metadata/...>`.
// Get this format wrong and the link lands on Plex's home screen
// instead of the title's page — household members would think the
// overlay was broken without any visible error.

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
    // The path segment is URL-encoded as part of the full key.
    expect(url).toContain('details?key=')
    expect(url).toContain(encodeURIComponent('/library/metadata/rkñ'))
  })

  it('places the server id in the hash route segment, not the query', () => {
    const url = buildPlexDeepLink('SERVER_ID_HERE', '101')
    // The hash uses #!/ — anything after must include the server id
    // before the details path. Off-by-one in this template silently
    // broke the link in prior iterations.
    expect(url).toMatch(/#!\/server\/SERVER_ID_HERE\/details\?key=/)
  })
})
