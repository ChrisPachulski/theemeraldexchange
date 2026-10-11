import { readFileSync } from 'fs'
import { test, expect, type Page, type Route } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Title detail parity with the Apple app: trailers & extras, Watchlist (detail
// toggle + Home shelf), More like this, the person page, Like / Dislike, and
// the player's end card. Every /api call is mocked, YouTube included.

const WEBM = readFileSync('tests/fixtures/webm/episode-60s.webm')
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const MATRIX = {
  id: 7, tmdbId: 603, title: 'The Matrix', year: 1999, added: '2026-10-01T00:00:00Z', certification: 'R',
  images: [], monitored: true, hasFile: true, status: 'released',
}
const BREAKING_BAD = {
  id: 11, tvdbId: 81189, tmdbId: 1396, title: 'Breaking Bad', year: 2008, added: '2026-10-01T00:00:00Z', status: 'ended',
  images: [], monitored: true, qualityProfileId: 1, rootFolderPath: '/tv',
  seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 3, totalEpisodeCount: 3, episodeFileCount: 3 } }],
  statistics: { seasonCount: 1, episodeCount: 3, totalEpisodeCount: 3, episodeFileCount: 3, sizeOnDisk: 0 },
}
const TRAILER = { key: 'vKQi3bBA1y8', name: 'Official Trailer', type: 'Trailer', official: true }
const EXTRA = { key: 'm8e-FF8MsqU', name: 'Bullet Time', type: 'Featurette', official: false }
const RELOADED = { tmdbId: 604, title: 'The Matrix Reloaded', year: 2003, posterPath: null }
const SAUL = { tmdbId: 60059, title: 'Better Call Saul', year: 2015, posterPath: null }
const PERSON = {
  id: 17419, name: 'Bryan Cranston', profile_path: null, known_for_department: 'Acting',
  biography: 'An American actor best known for Breaking Bad.',
  cast: [
    { id: 124905, media_type: 'movie', title: 'Godzilla', name: null, poster_path: null, release_date: '2014-05-14', first_air_date: null, character: 'Joe Brody' },
    { id: 1396, media_type: 'tv', title: null, name: 'Breaking Bad', poster_path: null, release_date: null, first_air_date: '2008-01-20', character: 'Walter White' },
  ],
}

async function setup(page: Page, opts: { mediaEnabled?: boolean; policy?: Record<string, unknown> } = {}) {
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/limits', (r) =>
    r.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, iptvEnabled: false, mediaEnabled: opts.mediaEnabled ?? false })),
  )
  await page.route('**/api/policy', (r) =>
    r.fulfill(json({ maxContentRating: null, allowedSections: null, kid: false, ...opts.policy })),
  )
  await page.route('**/api/radarr/api/v3/movie', (r) => r.fulfill(json([MATRIX])))
  await page.route('**/api/sonarr/api/v3/series', (r) => r.fulfill(json([BREAKING_BAD])))
  await page.route('**/api/tmdb/**', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const movie = url.searchParams.get('type') === 'movie'
    if (p.endsWith('/credits')) {
      return route.fulfill(json({
        cast: movie
          ? [{ id: 6384, name: 'Keanu Reeves', character: 'Neo', profile_path: null }]
          : [{ id: 17419, name: 'Bryan Cranston', roles: [{ character: 'Walter White', episode_count: 62 }], profile_path: null }],
      }))
    }
    if (p.endsWith('/videos')) return route.fulfill(json({ videos: movie ? [TRAILER, EXTRA] : [] }))
    if (p.endsWith('/related')) return route.fulfill(json({ items: movie ? [RELOADED] : [SAUL] }))
    if (p.endsWith('/person/17419')) return route.fulfill(json(PERSON))
    return route.fulfill(json({}))
  })
  // Never reach YouTube from a test.
  await page.route(/youtube-nocookie\.com|img\.youtube\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<p>embed</p>' }),
  )
}

type Lookups = string[]
async function mockLookups(page: Page): Promise<{ movie: Lookups; tv: Lookups }> {
  const terms = { movie: [] as Lookups, tv: [] as Lookups }
  await page.route('**/api/radarr/api/v3/movie/lookup**', (route) => {
    const term = new URL(route.request().url()).searchParams.get('term') ?? ''
    terms.movie.push(term)
    const hits: Record<string, unknown[]> = {
      'tmdb:604': [{ tmdbId: 604, title: 'The Matrix Reloaded', year: 2003, images: [] }],
      'tmdb:124905': [{ tmdbId: 124905, title: 'Godzilla', year: 2014, images: [] }],
    }
    return route.fulfill(json(hits[term] ?? []))
  })
  await page.route('**/api/sonarr/api/v3/series/lookup**', (route) => {
    const term = new URL(route.request().url()).searchParams.get('term') ?? ''
    terms.tv.push(term)
    // Sonarr can't resolve this show's TMDB id; the title finds it.
    const saul = { tvdbId: 273181, tmdbId: 60059, title: 'Better Call Saul', year: 2015, images: [] }
    return route.fulfill(json(term === 'Better Call Saul' || term === 'tvdb:273181' ? [saul] : []))
  })
  return terms
}

// Stateful per-member watchlist: every write echoes the list, as the server does.
async function mockWatchlist(page: Page, initial: Array<Record<string, unknown>> = []) {
  let items = [...initial]
  const writes: Array<{ method: string; path: string; body: unknown }> = []
  // A regex, not a glob: `**/api/watchlist**` also matches Vite's
  // /src/lib/api/watchlist.ts module request.
  await page.route(/\/api\/watchlist(\/|\?|$)/, (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const m = path.match(/\/api\/watchlist\/(movie|tv)\/(\d+)$/)
    if (m) {
      const [kind, id] = [m[1], Number(m[2])]
      const body = req.method() === 'PUT' ? req.postDataJSON() : undefined
      writes.push({ method: req.method(), path, body })
      items = items.filter((e) => !(e.kind === kind && e.id === id))
      if (body) items = [{ kind, id, ...body, added_at: new Date().toISOString() }, ...items]
    }
    return route.fulfill(json({ items }))
  })
  return writes
}

test('a movie detail plays its trailer in the privacy-enhanced embed and keeps the detail open', async ({ page }) => {
  await setup(page)
  await page.goto('/#/movies/7')
  const detail = page.getByRole('dialog', { name: 'The Matrix' })
  await expect(detail.getByText('Trailers & extras')).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Play Bullet Time' })).toBeVisible()

  await detail.getByRole('button', { name: 'Trailer', exact: true }).click()
  const trailer = page.getByRole('dialog', { name: 'Trailer: Official Trailer' })
  await expect(trailer.locator('iframe')).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/vKQi3bBA1y8?autoplay=1&rel=0&playsinline=1',
  )
  // Escape closes the trailer only, not the detail under it.
  await page.keyboard.press('Escape')
  await expect(trailer).toHaveCount(0)
  await expect(detail).toBeVisible()

  await detail.getByRole('button', { name: 'Play Bullet Time' }).click()
  await expect(page.getByRole('dialog', { name: 'Trailer: Bullet Time' }).locator('iframe')).toHaveAttribute(
    'src',
    /embed\/m8e-FF8MsqU\?/,
  )
  await page.getByRole('button', { name: 'Close trailer' }).click()
  await expect(page.getByRole('dialog', { name: /^Trailer:/ })).toHaveCount(0)
  await expect(detail).toBeVisible()
})

test('Watchlist toggles on the detail and the Home shelf opens each title in its tab', async ({ page }) => {
  await setup(page)
  const terms = await mockLookups(page)
  const writes = await mockWatchlist(page, [
    { kind: 'tv', id: 273181, title: 'Better Call Saul', added_at: '2026-10-01T00:00:00Z' },
  ])

  await page.goto('/#/movies/7')
  const detail = page.getByRole('dialog', { name: 'The Matrix' })
  const toggle = detail.getByRole('button', { name: 'Watchlist', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(detail.getByRole('button', { name: 'On watchlist' })).toHaveAttribute('aria-pressed', 'true')
  expect(writes).toEqual([{ method: 'PUT', path: '/api/watchlist/movie/603', body: { title: 'The Matrix' } }])

  await page.goto('/#/home')
  const shelf = page.getByRole('region', { name: 'Watchlist' })
  // Newest first.
  await expect(shelf.getByRole('button')).toHaveText([/The Matrix/, /Better Call Saul/])
  await shelf.getByRole('button', { name: /The Matrix/ }).click()
  // Owned: opens the library entry, no lookup.
  await expect(page.getByRole('dialog', { name: 'The Matrix' }).getByText('In library')).toBeVisible()
  expect(terms.movie).toEqual([])

  await page.goto('/#/home')
  await page.getByRole('region', { name: 'Watchlist' }).getByRole('button', { name: /Better Call Saul/ }).click()
  // Not owned: resolves by its stored TVDB id into the Discover detail.
  await expect(page.getByRole('dialog', { name: 'Better Call Saul' })).toBeVisible()
  await expect(page).toHaveURL(/#\/tv$/)
  expect(terms.tv).toEqual(['tvdb:273181'])

  await page.getByRole('dialog', { name: 'Better Call Saul' }).getByRole('button', { name: 'On watchlist' }).click()
  await expect(page.getByRole('dialog', { name: 'Better Call Saul' }).getByRole('button', { name: 'Watchlist', exact: true })).toBeVisible()
  expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/api/watchlist/tv/273181', body: undefined })
})

test('a capped member sees only watchlist titles the library can vouch for', async ({ page }) => {
  await setup(page, { policy: { maxContentRating: 'R' } })
  await mockWatchlist(page, [
    { kind: 'movie', id: 603, title: 'The Matrix', added_at: '2026-10-02T00:00:00Z' },
    { kind: 'tv', id: 273181, title: 'Better Call Saul', added_at: '2026-10-01T00:00:00Z' },
  ])

  await page.goto('/#/home')
  const shelf = page.getByRole('region', { name: 'Watchlist' })
  await expect(shelf.getByRole('button', { name: /The Matrix/ })).toBeVisible()
  // Unrated (not in the library): fails closed under a cap.
  await expect(shelf.getByText('Better Call Saul')).toHaveCount(0)

  // Related titles are unrated too: no More like this row on a capped detail.
  await page.goto('/#/movies/7')
  const detail = page.getByRole('dialog', { name: 'The Matrix' })
  await expect(detail.getByText('Trailers & extras')).toBeVisible()
  await expect(detail.getByText('More like this')).toHaveCount(0)
})

test('More like this opens the related title in the same detail; a show falls back to its title', async ({ page }) => {
  await setup(page)
  const terms = await mockLookups(page)

  await page.goto('/#/movies/7')
  const matrix = page.getByRole('dialog', { name: 'The Matrix' })
  const row = matrix.locator('section.trending', { has: page.getByRole('heading', { name: 'More like this' }) })
  await row.getByRole('button', { name: /The Matrix Reloaded/ }).click()
  await expect(page.getByRole('dialog', { name: 'The Matrix Reloaded' })).toBeVisible()
  expect(terms.movie).toEqual(['tmdb:604'])

  await page.goto('/#/tv/11')
  const bb = page.getByRole('dialog', { name: 'Breaking Bad' })
  await bb.locator('section.trending').getByRole('button', { name: /Better Call Saul/ }).click()
  await expect(page.getByRole('dialog', { name: 'Better Call Saul' })).toBeVisible()
  expect(terms.tv).toEqual(['tmdb:60059', 'Better Call Saul'])
})

test('a cast card opens the person page, and a movie credit from a show opens in the Movies tab', async ({ page }) => {
  await setup(page)
  const terms = await mockLookups(page)

  await page.goto('/#/tv/11')
  const detail = page.getByRole('dialog', { name: 'Breaking Bad' })
  await detail.getByText('Cast', { exact: true }).click()
  await detail.getByRole('button', { name: /Bryan Cranston/ }).click()

  const person = page.getByRole('dialog', { name: 'Bryan Cranston' })
  await expect(person.getByText('An American actor best known for Breaking Bad.')).toBeVisible()
  await expect(person.getByText('Acting')).toBeVisible()
  await expect(person.getByRole('button', { name: /Godzilla 2014/ })).toBeVisible()
  await expect(person.getByRole('button', { name: /Breaking Bad 2008/ })).toBeVisible()

  await person.getByRole('button', { name: /Godzilla/ }).click()
  await expect(page.getByRole('dialog', { name: 'Godzilla' })).toBeVisible()
  await expect(page).toHaveURL(/#\/movies$/)
  await expect(page.getByRole('dialog', { name: 'Bryan Cranston' })).toHaveCount(0)
  expect(terms.movie).toEqual(['tmdb:124905'])
})

test('Like and Dislike rate the title; pressing the active one clears it', async ({ page }) => {
  await setup(page)
  const fb = { movie: { liked: [] as unknown[], disliked: [] as unknown[] }, tv: { liked: [], disliked: [] } }
  const calls: string[] = []
  await page.route('**/api/feedback**', (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      const b = req.postDataJSON() as { tmdbId: number; title: string; signal: 'like' | 'dislike' }
      calls.push(`POST ${b.signal} ${b.tmdbId}`)
      fb.movie.liked = b.signal === 'like' ? [{ id: b.tmdbId, title: b.title }] : []
      fb.movie.disliked = b.signal === 'dislike' ? [{ id: b.tmdbId, title: b.title }] : []
    } else if (req.method() === 'DELETE') {
      calls.push(`DELETE ${new URL(req.url()).pathname}`)
      fb.movie = { liked: [], disliked: [] }
    }
    return route.fulfill(json(fb))
  })

  await page.goto('/#/movies/7')
  const detail = page.getByRole('dialog', { name: 'The Matrix' })
  await detail.getByRole('button', { name: 'Like', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Liked' })).toHaveAttribute('aria-pressed', 'true')
  await detail.getByRole('button', { name: 'Dislike', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Disliked' })).toHaveAttribute('aria-pressed', 'true')
  await expect(detail.getByRole('button', { name: 'Like', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await detail.getByRole('button', { name: 'Disliked' }).click()
  await expect(detail.getByRole('button', { name: 'Dislike', exact: true })).toHaveAttribute('aria-pressed', 'false')
  expect(calls).toEqual(['POST like 603', 'POST dislike 603', 'DELETE /api/feedback/movie/603/dislike'])
})

// Local media for the end-card tests: two movies (The Matrix + Reloaded) and a
// three-episode Breaking Bad, all streaming the same 60 s WebM.
async function mockMedia(page: Page) {
  const grants: Array<{ kind: string; id: number; start?: number }> = []
  await page.route('**/api/media/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const grant = p.match(/\/playback\/(movie|episode)\/(\d+)$/)
    if (grant) {
      const body = route.request().postDataJSON() as { start_secs?: number }
      grants.push({ kind: grant[1], id: Number(grant[2]), start: body.start_secs })
      return route.fulfill(json({ delivery: 'progressive', url: `/api/media/stream/${grant[1]}/${grant[2]}?t=tok`, durationSecs: 60 }))
    }
    if (p.startsWith('/api/media/stream/')) {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '')
      if (!range) {
        return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: WEBM })
      }
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) : WEBM.length - 1
      return route.fulfill({
        status: 206,
        contentType: 'video/webm',
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${WEBM.length}` },
        body: WEBM.subarray(start, end + 1),
      })
    }
    if (p.endsWith('/movies')) {
      return route.fulfill(json({
        items: [
          { id: 9, tmdb_id: 603, imdb_id: null, title: 'The Matrix', year: 1999, added_at: '2026-01-01T00:00:00Z', file_id: 1 },
          { id: 10, tmdb_id: 604, imdb_id: null, title: 'The Matrix Reloaded', year: 2003, added_at: '2026-01-01T00:00:00Z', file_id: 2 },
        ],
        total: 2,
      }))
    }
    if (p.endsWith('/shows')) {
      return route.fulfill(json({
        items: [{ id: 5, tmdb_id: 1396, tvdb_id: 81189, title: 'Breaking Bad', year: 2008, added_at: '2026-01-01T00:00:00Z' }],
        total: 1,
      }))
    }
    if (p.endsWith('/shows/5/episodes')) {
      return route.fulfill(json({
        items: [1, 2, 3].map((n) => ({ id: 100 + n, show_id: 5, season: 1, episode: n, title: `Chapter ${n}`, air_date: null, file_id: 200 + n })),
      }))
    }
    if (p.endsWith('/watch')) return route.fulfill(json(route.request().method() === 'GET' ? { items: [] } : { ok: true }))
    return route.fulfill(json({ items: [] }))
  })
  return grants
}

const video = (page: Page) => page.getByTestId('iptv-player-video')

async function playToEnd(page: Page) {
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 59.5
  })
}

test('end card after a movie: Replay starts it over, a local pick plays in place', async ({ page }) => {
  await setup(page, { mediaEnabled: true })
  const grants = await mockMedia(page)

  await page.goto('/#/movies/7')
  await page.getByRole('dialog', { name: 'The Matrix' }).getByRole('button', { name: 'Play Direct here' }).click()
  const player = page.getByRole('dialog', { name: 'The Matrix', exact: true })
  await playToEnd(page)

  const card = page.getByRole('group', { name: 'Finished' })
  await expect(card).toContainText('The Matrix')
  await card.getByRole('button', { name: 'Replay' }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(() => grants.filter((g) => g.id === 9).length).toBeGreaterThan(1)
  expect(grants.at(-1)).toEqual({ kind: 'movie', id: 9, start: undefined })

  await playToEnd(page)
  await card.locator('section.trending').getByRole('button', { name: /The Matrix Reloaded/ }).click()
  await expect(page.getByRole('heading', { name: 'The Matrix Reloaded' })).toBeVisible()
  expect(grants.at(-1)).toMatchObject({ kind: 'movie', id: 10 })
  await expect(player).toHaveCount(0)
})

test("end card after a show's last episode: Done closes the player", async ({ page }) => {
  await setup(page, { mediaEnabled: true })
  await mockMedia(page)

  await page.goto('/#/tv/11')
  await page.getByRole('dialog', { name: 'Breaking Bad' }).getByRole('button', { name: 'Watch episodes here' }).click()
  await page.getByRole('button', { name: /S01E03/ }).click()
  await playToEnd(page)

  const card = page.getByRole('group', { name: 'Finished' })
  await expect(card.getByRole('button', { name: /Better Call Saul/ })).toBeVisible()
  await card.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog', { name: /Breaking Bad/ })).toHaveCount(0)
})
