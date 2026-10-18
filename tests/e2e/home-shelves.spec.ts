import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Home shelves (Apple HomeScreen parity) and the open-a-title intent behind
// them: Continue watching resumes in place, Recently added and picks open the
// title's detail in its tab, On now tunes a favourite channel in Live.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const DUNE = {
  id: 7, tmdbId: 438631, title: 'Dune', year: 2021, added: '2026-10-09T10:00:00Z',
  images: [], monitored: true, hasFile: true, status: 'released',
}

async function setup(page: Page, limits: Record<string, unknown> = {}) {
  await installBackgroundMocks(page)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, iptvEnabled: false, mediaEnabled: false, ...limits })),
  )
  await page.route('**/api/recommender/event', (route) => route.fulfill(json({})))
  await mockMe(page, ADMIN_USER)
}

test('Continue watching lists in-progress titles and resumes one in place', async ({ page }) => {
  await setup(page, { mediaEnabled: true })
  await page.route('**/api/media/**', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.endsWith('/watch')) {
      return route.fulfill(json({
        items: [
          {
            media_kind: 'episode', media_id: 9, position_secs: 300, duration_secs: 1500,
            watched_at: '2026-10-09T20:00:00Z', completed: 0,
            title: 'Good News About Hell', show_title: 'Severance', poster_path: null, season: 1, episode: 2,
          },
          {
            media_kind: 'movie', media_id: 3, position_secs: 7000, duration_secs: 7100,
            watched_at: '2026-10-08T20:00:00Z', completed: 1, title: 'Finished Film', poster_path: null,
          },
        ],
      }))
    }
    if (p.includes('/playback/')) {
      return route.fulfill(json({ delivery: 'progressive', url: '/api/media/stream/episode/9?t=tok', durationSecs: 1500 }))
    }
    return route.fulfill(json({ items: [] }))
  })

  await page.goto('/#/home')
  const shelf = page.getByRole('region', { name: 'Continue watching' })
  const card = shelf.getByRole('button', { name: /Severance/ })
  await expect(card).toContainText('S1 · E2')
  await expect(shelf.getByText('Finished Film')).toHaveCount(0)

  const grant = page.waitForRequest((r) => r.url().includes('/api/media/playback/episode/9'))
  await card.click()
  // One tap resumes at the saved offset: no resume-or-start-over prompt.
  expect((await grant).postDataJSON().start_secs).toBe(300)
  await expect(page.getByRole('group', { name: 'Resume playback' })).toHaveCount(0)
})

test('Continue watching shows the empty state when nothing is in progress', async ({ page }) => {
  await setup(page, { mediaEnabled: true })
  await page.route('**/api/media/**', (route) => route.fulfill(json({ items: [] })))

  await page.goto('/#/home')
  await expect(
    page.getByRole('region', { name: 'Continue watching' }).getByText('Nothing to jump back into yet'),
  ).toBeVisible()
})

test('a Recently added movie opens its detail in the Movies tab', async ({ page }) => {
  await setup(page)
  await page.route('**/api/radarr/api/v3/movie', (route) => route.fulfill(json([DUNE])))

  await page.goto('/#/home')
  await page.getByRole('region', { name: 'Recently added movies' }).getByRole('button', { name: /Dune/ }).click()

  await expect(page.getByRole('dialog', { name: 'Dune' })).toBeVisible()
  // The intent is consumed: the URL settles on the plain tab route.
  await expect(page).toHaveURL(/#\/movies$/)
})

test('the Downloads "Recently added" card opens the title, not just the tab', async ({ page }) => {
  await setup(page)
  await page.route('**/api/radarr/api/v3/movie', (route) => route.fulfill(json([DUNE])))

  await page.goto('/#/downloads')
  await page.getByRole('region', { name: 'Recently added to the library' }).getByRole('button', { name: /Dune/ }).click()

  await expect(page.getByRole('dialog', { name: 'Dune' })).toBeVisible()
})

test('a movie pick resolves through Radarr lookup and opens its detail', async ({ page }) => {
  await setup(page)
  await page.route('**/api/suggestions/movie**', (route) =>
    route.fulfill(json({ source: 'recommender', items: [{ id: 603, title: 'The Matrix', year: 1999, posterPath: null }] })),
  )
  const terms: string[] = []
  await page.route('**/api/radarr/api/v3/movie/lookup**', (route) => {
    terms.push(new URL(route.request().url()).searchParams.get('term') ?? '')
    return route.fulfill(json([{ tmdbId: 603, title: 'The Matrix', year: 1999, images: [] }]))
  })

  await page.goto('/#/home')
  const shelf = page.locator('section.trending', { has: page.getByRole('heading', { name: 'Movies picked for you' }) })
  const clicked = page.waitForRequest((r) => r.url().includes('/api/recommender/event'))
  await shelf.getByRole('button', { name: /^The Matrix/ }).click()
  await clicked

  await expect(page.getByRole('dialog', { name: 'The Matrix' })).toBeVisible()
  expect(terms).toEqual(['tmdb:603'])
})

test('On now shows a favourite channel airing and tunes it in Live', async ({ page }) => {
  await setup(page, { iptvEnabled: true })
  const now = Date.now()
  const programme = {
    channel_id: 'tsn4.ca',
    start_utc: new Date(now - 20 * 60_000).toISOString(),
    stop_utc: new Date(now + 40 * 60_000).toISOString(),
    title: 'NHL Hockey',
    description: null,
  }
  await page.route('**/api/iptv/**', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.endsWith('/favorites')) return route.fulfill(json([{ sub: '', kind: 'live', item_id: '300001', added_ts: '' }]))
    if (p.endsWith('/epg/now')) return route.fulfill(json([{ channel_stream_id: 300001, current: programme, next: null }]))
    if (p.endsWith('/grant')) return route.fulfill(json({ url: '/api/iptv/stream/live/300001/remux/index.m3u8?t=tok', delivery: 'hls' }))
    if (p.endsWith('/live')) return route.fulfill(json({ items: [], total: 0, limit: 100, offset: 0 }))
    if (p.endsWith('/sessions')) return route.fulfill(json({ sessions: [], max: 2 }))
    if (p.endsWith('/categories') || p.endsWith('/epg/grid')) return route.fulfill(json([]))
    return route.fulfill(json({}))
  })

  await page.goto('/#/home')
  const shelf = page.getByRole('region', { name: 'On now' })
  await expect(shelf.getByRole('button', { name: 'Channel guide' })).toBeVisible()
  const tile = shelf.getByRole('button', { name: /NHL Hockey/ })
  await expect(tile).toContainText(/On now · (39|40)m left/)

  const grant = page.waitForRequest((r) => r.url().includes('/stream/live/300001/grant'))
  await tile.click()
  await grant
  await expect(page).toHaveURL(/#\/live$/)
})

test('a show pick resolves through Sonarr and opens the owned library entry', async ({ page }) => {
  await setup(page)
  // Sonarr often carries tmdbId 0, so an owned show can still be suggested;
  // the tvdb join after lookup must land on the library entry.
  const owned = {
    id: 5, tvdbId: 81189, tmdbId: 0, title: 'Breaking Bad', year: 2008, added: '2026-10-01T00:00:00Z',
    images: [], seasons: [], monitored: true, statistics: { episodeFileCount: 62 },
  }
  await page.route('**/api/sonarr/api/v3/series', (route) => route.fulfill(json([owned])))
  await page.route('**/api/suggestions/tv**', (route) =>
    route.fulfill(json({ source: 'recommender', items: [{ id: 1396, title: 'Breaking Bad', year: 2008, posterPath: null }] })),
  )
  const terms: string[] = []
  await page.route('**/api/sonarr/api/v3/series/lookup**', (route) => {
    terms.push(new URL(route.request().url()).searchParams.get('term') ?? '')
    return route.fulfill(json([{ tvdbId: 81189, tmdbId: 1396, title: 'Breaking Bad', year: 2008, images: [] }]))
  })

  await page.goto('/#/home')
  const shelf = page.locator('section.trending', { has: page.getByRole('heading', { name: 'Shows picked for you' }) })
  await shelf.getByRole('button', { name: /^Breaking Bad/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Breaking Bad' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('In library')).toBeVisible()
  await expect(page).toHaveURL(/#\/tv$/)
  expect(terms).toEqual(['tmdb:1396'])
})

test('posters load from the server image route, never from TMDB', async ({ page }) => {
  await setup(page)
  const tmdbHits: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).hostname === 'image.tmdb.org') tmdbHits.push(r.url())
  })
  await page.route('https://image.tmdb.org/**', (route) => route.abort())
  const served: string[] = []
  await page.route('**/api/media/images/**', (route) => {
    served.push(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"/>' })
  })
  // A Radarr remoteUrl (any TMDB size), a stored watchlist row's bare path and
  // a suggestion's bare poster_path.
  await page.route('**/api/radarr/api/v3/movie', (route) =>
    route.fulfill(json([{ ...DUNE, images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/dune.jpg' }] }])),
  )
  await page.route('**/api/watchlist', (route) =>
    route.fulfill(json({ items: [{ kind: 'movie', id: 603, title: 'The Matrix', poster_path: '/matrix.jpg', added_at: '2026-10-01T00:00:00Z' }] })),
  )
  await page.route('**/api/suggestions/movie**', (route) =>
    route.fulfill(json({ source: 'recommender', items: [{ id: 27205, title: 'Inception', year: 2010, posterPath: '/inception.jpg' }] })),
  )

  await page.goto('/#/home')
  for (const [shelf, title, file] of [
    ['Recently added movies', 'Dune', 'dune.jpg'],
    ['Watchlist', 'The Matrix', 'matrix.jpg'],
  ] as const) {
    const img = page.getByRole('region', { name: shelf }).getByRole('button', { name: new RegExp(title) }).locator('img')
    await expect(img).toHaveAttribute('src', new RegExp(`/api/media/images/tmdb/${file}\\?w=342$`))
    await expect(img).toHaveAttribute('srcset', new RegExp(`/api/media/images/tmdb/${file}\\?w=500 500w`))
  }
  const pick = page.locator('section.trending', { has: page.getByRole('heading', { name: 'Movies picked for you' }) })
  await expect(pick.getByRole('button', { name: /^Inception/ }).locator('img')).toHaveAttribute('src', /\/api\/media\/images\/tmdb\/inception\.jpg\?w=342$/)
  await expect.poll(() => served.some((p) => p === '/api/media/images/tmdb/inception.jpg')).toBe(true)

  // The detail's poster and backdrop take the same route.
  await page.getByRole('region', { name: 'Recently added movies' }).getByRole('button', { name: /Dune/ }).click()
  await expect(page.getByRole('dialog', { name: 'Dune' }).locator('img.detail__poster')).toHaveAttribute('src', /\/api\/media\/images\/tmdb\/dune\.jpg\?w=342$/)
  expect(tmdbHits).toEqual([])
})
