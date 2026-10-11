import { test, expect, type Page } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Library parity with the Apple app: one-tap Resume/Play SxEy and a playable
// season browser on a show's detail, watch state on posters and the movie
// Play label, genre filter + tappable genre pills, Recently added / Rating
// sorts, Missing markers, the Browse shelves and the add dialogs' load-failure
// state. Every /api call is mocked.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const DUNE = {
  id: 7, tmdbId: 438631, title: 'Dune', year: 2021, added: '2026-03-01T00:00:00Z', status: 'released',
  hasFile: true, monitored: true, qualityProfileId: 1, rootFolderPath: '/movies', images: [],
  genres: ['Science Fiction', 'Adventure'], ratings: { imdb: { value: 8.0 } }, digitalRelease: '2021-10-22',
}
const ALIEN = {
  ...DUNE, id: 8, tmdbId: 348, title: 'Alien', year: 1979, added: '2026-01-01T00:00:00Z',
  genres: ['Horror', 'Science Fiction'], ratings: { imdb: { value: 8.5 } }, digitalRelease: '2003-12-02',
}
const WANTED = {
  ...DUNE, id: 9, tmdbId: 999, title: 'Wanted', year: 2008, added: '2026-05-01T00:00:00Z',
  hasFile: false, genres: ['Action'], ratings: { tmdb: { value: 6.4 } },
}
const MOVIES = [DUNE, ALIEN, WANTED]

const SHOW = {
  id: 11, title: 'Test Show', tvdbId: 500, tmdbId: 900, year: 2020, status: 'continuing', images: [],
  genres: ['Drama', 'Mystery'], ratings: { value: 8.1 }, added: '2026-02-01T00:00:00Z',
  monitored: true, qualityProfileId: 1, rootFolderPath: '/tv',
  seasons: [
    { seasonNumber: 1, monitored: true, statistics: { episodeCount: 3, totalEpisodeCount: 3, episodeFileCount: 3 } },
    { seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, episodeFileCount: 1 } },
  ],
  statistics: { seasonCount: 2, episodeCount: 5, totalEpisodeCount: 5, episodeFileCount: 4, sizeOnDisk: 0 },
}
const EMPTY_SHOW = {
  ...SHOW, id: 12, title: 'Other Show', tvdbId: 501, tmdbId: 901, genres: ['Comedy'], ratings: { value: 6 },
  added: '2026-04-01T00:00:00Z', seasons: [],
  statistics: { seasonCount: 1, episodeCount: 4, totalEpisodeCount: 4, episodeFileCount: 0, sizeOnDisk: 0 },
}
const SONARR_EPISODES = [
  [1, 1, 'Pilot', true], [1, 2, 'Second', true], [1, 3, 'Third', true], [2, 1, 'Return', true], [2, 2, 'Later', false],
].map(([season, episode, title, hasFile], i) => ({
  id: 50 + i, seriesId: 11, seasonNumber: season, episodeNumber: episode, title, hasFile, monitored: true,
  airDate: '2020-01-0' + (i + 1), overview: `${title} synopsis.`,
}))
const MEDIA_EPISODES = [[101, 1, 1], [102, 1, 2], [103, 1, 3], [104, 2, 1]].map(([id, season, episode]) => ({
  id, show_id: 5, season, episode, title: null, air_date: null, file_id: id,
}))

type WatchRow = Record<string, unknown>
const watchRow = (kind: string, id: number, pos: number, dur: number, completed = false): WatchRow => ({
  media_kind: kind, media_id: id, position_secs: pos, duration_secs: dur,
  watched_at: `2026-10-0${id % 9}T20:00:00Z`, completed: completed ? 1 : 0,
  title: kind === 'episode' ? 'Ep' : 'Movie', show_title: kind === 'episode' ? 'Test Show' : null,
})

type Grant = { kind: string; id: number; body: Record<string, unknown> }

async function setup(page: Page, opts: { watch?: WatchRow[] } = {}): Promise<Grant[]> {
  const grants: Grant[] = []
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/limits', (r) => r.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, mediaEnabled: true })))
  await page.route('**/api/radarr/api/v3/movie', (r) => r.fulfill(json(MOVIES)))
  await page.route('**/api/sonarr/api/v3/series', (r) => r.fulfill(json([SHOW, EMPTY_SHOW])))
  await page.route(/\/api\/sonarr\/api\/v3\/episode\?/, (r) => r.fulfill(json(SONARR_EPISODES)))
  await page.route('**/api/media/**', async (route) => {
    const p = new URL(route.request().url()).pathname
    const grant = p.match(/\/playback\/(movie|episode)\/(\d+)$/)
    if (grant) {
      grants.push({ kind: grant[1], id: Number(grant[2]), body: route.request().postDataJSON() as Record<string, unknown> })
      // Never resolving keeps the player on its loading state: these tests
      // assert what was granted, not playback.
      return
    }
    if (p.endsWith('/shows/5/episodes')) return route.fulfill(json({ items: MEDIA_EPISODES }))
    if (p.endsWith('/shows')) {
      return route.fulfill(json({ items: [{ id: 5, tmdb_id: 900, tvdb_id: 500, title: 'Test Show', year: 2020, added_at: '2026-01-01' }] }))
    }
    if (p.endsWith('/movies')) {
      return route.fulfill(json({
        items: [
          { id: 3, tmdb_id: 438631, imdb_id: null, title: 'Dune', year: 2021, added_at: '2026-01-01', file_id: 1 },
          { id: 4, tmdb_id: 348, imdb_id: null, title: 'Alien', year: 1979, added_at: '2026-01-01', file_id: 2 },
        ],
      }))
    }
    if (p.endsWith('/watch')) return route.fulfill(json({ items: opts.watch ?? [] }))
    return route.fulfill(json({ items: [] }))
  })
  return grants
}

async function openLibrary(page: Page, tab: 'movies' | 'tv') {
  await page.goto(`/#/${tab}`)
  await page.getByRole('tab', { name: /In library/ }).click()
}

const cardTitles = (page: Page) => page.locator('.media-card__title').allTextContents()

test('library sorts by Recently added and by Rating', async ({ page }) => {
  await setup(page)
  await openLibrary(page, 'movies')
  await expect.poll(() => cardTitles(page)).toEqual(['Alien', 'Dune', 'Wanted'])

  await page.getByRole('combobox', { name: 'Sort library' }).selectOption('Recently added')
  await expect.poll(() => cardTitles(page)).toEqual(['Wanted', 'Dune', 'Alien'])
  // IMDb first, TMDB when IMDb is absent.
  await page.getByRole('combobox', { name: 'Sort library' }).selectOption('Rating')
  await expect.poll(() => cardTitles(page)).toEqual(['Alien', 'Dune', 'Wanted'])
})

test('genre filter narrows the grid, and a detail genre pill opens the filtered library', async ({ page }) => {
  await setup(page)
  await openLibrary(page, 'movies')
  const genre = page.getByRole('combobox', { name: 'Filter by genre' })
  await expect(genre.locator('option')).toHaveText(['All genres', 'Action', 'Adventure', 'Horror', 'Science Fiction'])
  await genre.selectOption('Horror')
  await expect.poll(() => cardTitles(page)).toEqual(['Alien'])
  await genre.selectOption('all')

  await page.getByRole('button', { name: /^Dune/ }).click()
  const detail = page.getByRole('dialog', { name: 'Dune' })
  await detail.getByRole('button', { name: 'Adventure' }).click()
  await expect(detail).toHaveCount(0)
  await expect(genre).toHaveValue('Adventure')
  await expect.poll(() => cardTitles(page)).toEqual(['Dune'])

  // A genre no visible title carries names itself in the empty state.
  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('announced')
  await expect(page.getByText('No Adventure movies in your library.')).toBeVisible()
})

test('library posters show watch state and Missing, and a resumable movie reads Resume', async ({ page }) => {
  const grants = await setup(page, { watch: [watchRow('movie', 3, 600, 3200), watchRow('movie', 4, 7000, 7000, true)] })
  await openLibrary(page, 'movies')
  const card = (title: string) => page.getByRole('button', { name: title })
  await expect(card('Alien')).toContainText('Watched')
  await expect(card('Dune').locator('.media-card__progress > span')).toHaveAttribute('style', 'width: 19%;')
  await expect(card('Dune')).not.toContainText('Watched')
  await expect(card('Wanted')).toContainText('Missing')
  await expect(card('Dune')).not.toContainText('Missing')

  await card('Dune').click()
  await page.getByRole('dialog', { name: 'Dune' }).getByRole('button', { name: 'Resume · 43 min left' }).click()
  await page.getByRole('button', { name: 'Resume from 10:00' }).click()
  await expect.poll(() => grants.map((g) => [g.kind, g.id, g.body.start_secs])[0]).toEqual(['movie', 3, 600])

  await openLibrary(page, 'tv')
  await expect(card('Other Show')).toContainText('Missing')
  await expect(card('Test Show')).not.toContainText('Missing')
})
