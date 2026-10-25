import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// The app-wide Search page (Apple's Search tab): one query reaches the library,
// episodes, live channels, guide programmes and titles not in the library yet,
// matched by words so "scooby-doo" finds "SCOOBY DOO". Every /api call is mocked.

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const OWNED_MOVIE = { id: 7, tmdbId: 1, title: 'Scooby-Doo', year: 2002, certification: 'PG', images: [] }
const OWNED_SHOW = { id: 5, tvdbId: 10, title: 'Scooby-Doo, Where Are You!', year: 1969, images: [] }
const CHANNEL = {
  stream_id: 201,
  num: 201,
  name: '24/7 SCOOBY DOO',
  stream_icon: null,
  epg_channel_id: 'scooby',
  category_id: 21,
  tv_archive: 0,
  tv_archive_duration: null,
}

async function setup(page: Page) {
  await installBackgroundMocks(page)
  await mockMe(page, ADMIN_USER)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, iptvEnabled: true, mediaEnabled: true })),
  )
  await page.route('**/api/radarr/api/v3/movie', (route) => route.fulfill(json([OWNED_MOVIE])))
  await page.route('**/api/radarr/api/v3/movie/lookup**', (route) =>
    route.fulfill(
      json([
        { ...OWNED_MOVIE, id: undefined },
        { tmdbId: 3, title: 'Scooby-Doo 2: Monsters Unleashed', year: 2004, certification: 'PG', images: [] },
      ]),
    ),
  )
  await page.route('**/api/sonarr/api/v3/series', (route) => route.fulfill(json([OWNED_SHOW])))
  await page.route('**/api/sonarr/api/v3/series/lookup**', (route) =>
    route.fulfill(
      json([
        { ...OWNED_SHOW, id: undefined },
        { tvdbId: 11, title: 'What’s New, Scooby-Doo?', year: 2002, images: [] },
      ]),
    ),
  )
  await page.route('**/api/media/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/episodes')) {
      return route.fulfill(
        json({
          items: [{ id: 900, show_id: 50, season: 1, episode: 2, title: 'A Clue for Scooby-Doo', air_date: null, file_id: 1 }],
          total: 1,
        }),
      )
    }
    if (url.pathname.endsWith('/shows')) {
      return route.fulfill(
        json({
          items: [{ id: 50, tmdb_id: null, tvdb_id: 10, title: OWNED_SHOW.title, year: 1969, added_at: '2026-01-01T00:00:00Z' }],
          total: 1,
        }),
      )
    }
    return route.fulfill(json({ items: [], total: 0 }))
  })
  const grants: string[] = []
  const channelQueries: string[] = []
  await page.route('**/api/iptv/**', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p.endsWith('/grant')) {
      grants.push(p)
      return route.fulfill(json({ url: '/api/iptv/stream/live/201/remux/index.m3u8?t=tok', delivery: 'hls', sessionId: 'live:201' }))
    }
    if (p.endsWith('/live')) {
      const q = url.searchParams.get('q')
      if (q) channelQueries.push(q)
      return route.fulfill(json({ items: q ? [CHANNEL] : [], total: q ? 1 : 0, limit: 24, offset: 0 }))
    }
    if (p.endsWith('/epg/search')) {
      const now = Date.now()
      return route.fulfill(
        json({
          total: 1,
          hits: [
            {
              streamId: 201,
              channelName: CHANNEL.name,
              categoryId: 21,
              programIndex: 0,
              programme: {
                channel_id: 'scooby',
                start_utc: new Date(now - 10 * 60_000).toISOString(),
                stop_utc: new Date(now + 20 * 60_000).toISOString(),
                title: 'Scooby-Doo and Guess Who?',
                description: null,
              },
            },
          ],
        }),
      )
    }
    if (p.endsWith('/categories') || p.endsWith('/favorites') || p.endsWith('/epg/now') || p.endsWith('/epg/grid')) {
      return route.fulfill(json([]))
    }
    return route.fulfill(json({}))
  })
  return { grants, channelQueries }
}

test('one query reaches the library, episodes, channels, programmes and titles to add', async ({ page }) => {
  const { grants, channelQueries } = await setup(page)
  await page.goto('/#/search')

  const field = page.getByRole('searchbox', { name: 'Search everything' })
  await expect(field).toBeFocused()
  await field.fill('scooby-doo')

  await expect(page.getByRole('region', { name: 'Movies' })).toContainText('Scooby-Doo')
  await expect(page.getByRole('region', { name: 'TV Shows' })).toContainText('Scooby-Doo, Where Are You!')
  await expect(page.getByRole('region', { name: 'Episodes' })).toContainText('A Clue for Scooby-Doo')
  await expect(page.getByRole('region', { name: 'Channels' })).toContainText('24/7 SCOOBY DOO')
  await expect(page.getByRole('region', { name: 'Matching programs' })).toContainText('Scooby-Doo and Guess Who?')
  const discover = page.getByRole('region', { name: 'Not in your library' })
  await expect(discover).toContainText('Scooby-Doo 2: Monsters Unleashed')
  await expect(discover).toContainText('What’s New, Scooby-Doo?')
  // Titles already in the library aren't offered again.
  await expect(discover.getByRole('button')).toHaveCount(2)
  expect(channelQueries).toContain('scooby-doo')

  // A channel tunes in the Live tab, titled by its name.
  await page.getByRole('region', { name: 'Channels' }).getByRole('button', { name: 'Watch 24/7 SCOOBY DOO live' }).click()
  await expect(page).toHaveURL(/#\/live$/)
  await expect.poll(() => grants).toContain('/api/iptv/stream/live/201/grant')
})

test('a library title opens its detail, and Back returns to the same results', async ({ page }) => {
  await setup(page)
  await page.goto('/#/search')
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('scoobydoo')

  await page.getByRole('region', { name: 'Movies' }).getByRole('button', { name: /Scooby-Doo/ }).click()
  await expect(page).toHaveURL(/#\/movies$/)
  await expect(page.getByRole('dialog', { name: /Scooby-Doo/ })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/#\/search$/)
  await expect(page.getByRole('searchbox', { name: 'Search everything' })).toHaveValue('scoobydoo')
  await expect(page.getByRole('region', { name: 'TV Shows' })).toContainText('Scooby-Doo, Where Are You!')
})

test('"/" opens Search from anywhere but a text field', async ({ page }) => {
  await setup(page)
  await page.goto('/#/home')
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
  // The shell's key listener attaches once the session settles after first paint.
  await expect(async () => {
    await page.keyboard.press('/')
    await expect(page).toHaveURL(/#\/search$/, { timeout: 500 })
  }).toPass()
  await expect(page.getByRole('searchbox', { name: 'Search everything' })).toBeFocused()
})
