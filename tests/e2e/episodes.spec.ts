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
const watchRow = (kind: string, id: number, pos: number, dur: number, completed = false): WatchRow => {
  const ep = MEDIA_EPISODES.find((e) => kind === 'episode' && e.id === id)
  return {
    media_kind: kind, media_id: id, position_secs: pos, duration_secs: dur,
    watched_at: `2026-10-0${id % 9}T20:00:00Z`, completed: completed ? 1 : 0,
    title: ep ? 'Ep' : 'Movie', show_title: ep ? 'Test Show' : null, season: ep?.season, episode: ep?.episode,
  }
}

type Grant = { kind: string; id: number; body: Record<string, unknown> }

async function setup(page: Page, opts: { watch?: WatchRow[]; movies?: unknown[] } = {}): Promise<Grant[]> {
  const grants: Grant[] = []
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/limits', (r) => r.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, mediaEnabled: true })))
  await page.route('**/api/radarr/api/v3/movie', (r) => r.fulfill(json(opts.movies ?? MOVIES)))
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

test('a show detail resumes in one tap and plays from its season browser', async ({ page }) => {
  const grants = await setup(page, {
    watch: [watchRow('episode', 101, 1400, 1400, true), watchRow('episode', 102, 300, 1500)],
  })
  await openLibrary(page, 'tv')
  await page.getByRole('button', { name: 'Test Show' }).click()
  const detail = page.getByRole('dialog', { name: 'Test Show' })
  await expect(detail.getByText('4 of 5', { exact: true })).toBeVisible()
  // Opens on the resume target's season, with downloaded and unwatched counts.
  await expect(detail.getByText('3 of 3 downloaded · 2 unwatched')).toBeVisible()
  await expect(detail.getByText('1 of 2 downloaded · 2 unwatched')).toBeVisible()
  const pilot = detail.getByRole('button', { name: /Pilot/ })
  await expect(pilot).toBeVisible()
  await expect(pilot).toContainText('Watched')
  await expect(pilot).toContainText('Pilot synopsis.')
  await expect(detail.getByRole('button', { name: /Second/ }).locator('.detail__episode-progress > span')).toHaveAttribute(
    'style',
    'width: 20%;',
  )

  await detail.getByRole('button', { name: 'Resume S1E2' }).click()
  // One tap: straight to the saved offset, no resume prompt.
  await expect.poll(() => grants.map((g) => [g.id, g.body.start_secs])[0]).toEqual([102, 300])
  await page.getByRole('button', { name: 'Close player' }).click()

  await page.getByRole('button', { name: 'Test Show' }).click()
  await detail.getByText('Season 2', { exact: true }).click()
  // Not downloaded locally: an info row, not a play button.
  await expect(detail.getByText('Later', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: /Later/ })).toHaveCount(0)
  await detail.getByRole('button', { name: /Return/ }).click()
  await expect.poll(() => grants.map((g) => g.id)).toContain(104)
})

test('a show with nothing watched offers Play S1E1', async ({ page }) => {
  const grants = await setup(page)
  await openLibrary(page, 'tv')
  await page.getByRole('button', { name: 'Test Show' }).click()
  await page.getByRole('dialog', { name: 'Test Show' }).getByRole('button', { name: 'Play S1E1' }).click()
  await expect.poll(() => grants.map((g) => g.id)[0]).toBe(101)
})

test('Browse mode shelves the library and its genre chips open the filtered grid', async ({ page }) => {
  const sciFi = (id: number, title: string, imdb: number, added: string) => ({
    ...DUNE, id, tmdbId: id * 10, title, added, genres: ['Science Fiction'], ratings: { imdb: { value: imdb } },
    digitalRelease: undefined,
  })
  await setup(page, {
    movies: [...MOVIES, sciFi(20, 'Arrival', 7.9, '2025-06-01T00:00:00Z'), sciFi(21, 'Her', 8.0, '2025-05-01T00:00:00Z')],
    watch: [watchRow('movie', 3, 600, 3200)],
  })
  await page.goto('/#/movies')
  await page.getByRole('tab', { name: 'Browse' }).click()

  const shelf = (label: string) => page.getByRole('region', { name: label }).locator('.trending__title')
  await expect(shelf('Continue watching')).toHaveText(['Dune'])
  await expect(page.getByRole('region', { name: 'Continue watching' }).locator('.home-shelf__progress > span')).toHaveAttribute(
    'style',
    'width: 19%;',
  )
  // Released titles only, newest release first; Wanted has no file.
  await expect(shelf('Recently released')).toHaveText(['Dune', 'Alien'])
  await expect(shelf('Recently added')).toHaveText(['Dune', 'Alien', 'Arrival', 'Her'])
  await expect(shelf('Top movies in Science Fiction')).toHaveText(['Alien', 'Dune', 'Her', 'Arrival'])

  await page.getByRole('region', { name: 'Recently added' }).getByRole('button', { name: 'Arrival' }).click()
  await expect(page.getByRole('dialog', { name: 'Arrival' })).toBeVisible()
  await page.getByRole('button', { name: 'Close detail view' }).click()

  await page.getByRole('region', { name: 'Browse by genre' }).getByRole('button', { name: 'Horror' }).click()
  await expect(page.getByRole('tab', { name: /In library/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('combobox', { name: 'Filter by genre' })).toHaveValue('Horror')
  await expect.poll(() => cardTitles(page)).toEqual(['Alien'])
})

test('Browse mode on TV resumes a show from its Continue watching card', async ({ page }) => {
  await setup(page, { watch: [watchRow('episode', 102, 300, 1500)] })
  // A real 500px-wide poster: an unsized shelf card would stretch to it.
  const poster = 'https://image.tmdb.org/t/p/original/test-show.jpg'
  await page.route('**/api/sonarr/api/v3/series', (r) =>
    r.fulfill(json([{ ...SHOW, images: [{ coverType: 'poster', remoteUrl: poster }] }, EMPTY_SHOW])),
  )
  await page.route(poster, (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"/>' }),
  )
  await page.goto('/#/tv')
  await page.getByRole('tab', { name: 'Browse' }).click()
  const resume = page.getByRole('region', { name: 'Continue watching' })
  await expect(resume.locator('.trending__title')).toHaveText(['Test Show'])
  await expect(resume).toContainText('S1 · E2')
  // Shelf sizing comes from Home's shelves stylesheet; posters stay poster-sized
  // here too, not stretched to the row.
  expect((await resume.locator('.trending__card-wrap').first().boundingBox())?.width).toBeLessThanOrEqual(168)
  // Other Show has nothing on disk, so only Test Show is shelved.
  await expect(page.getByRole('region', { name: 'Recently added' }).locator('.trending__title')).toHaveText(['Test Show'])
  await resume.getByRole('button', { name: 'Test Show' }).click()
  await expect(page.getByRole('dialog', { name: 'Test Show' }).getByRole('button', { name: 'Resume S1E2' })).toBeVisible()
})

for (const { kind, tab, search, lookup, title } of [
  { kind: 'radarr', tab: 'movies', search: /search movies/i, lookup: { tmdbId: 5, title: 'New Film', year: 2024, images: [] }, title: 'New Film' },
  { kind: 'sonarr', tab: 'tv', search: /search tv shows/i, lookup: { tvdbId: 6, title: 'New Series', year: 2024, images: [], seasons: [] }, title: 'New Series' },
]) {
  test(`${kind} add dialog: failed add options show Retry instead of dead selects`, async ({ page }) => {
    await setup(page)
    let healthy = false
    const opts = (body: unknown) => (route: import('@playwright/test').Route) =>
      healthy ? route.fulfill(json(body)) : route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    await page.route(`**/api/${kind}/api/v3/qualityprofile`, opts([{ id: 1, name: 'HD' }]))
    await page.route(`**/api/${kind}/api/v3/rootfolder`, opts([{ id: 1, path: '/media' }]))
    await page.route(`**/api/${kind}/api/v3/${kind === 'radarr' ? 'movie' : 'series'}/lookup**`, (r) => r.fulfill(json([lookup])))

    await page.goto(`/#/${tab}`)
    await page.getByRole('searchbox', { name: search }).fill('New')
    await page.getByRole('button', { name: new RegExp(title) }).click()
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Add to library' }).click()

    const notice = page.getByRole('alert').filter({ hasText: "Couldn't load add options." })
    await expect(notice).toBeVisible()
    await expect(page.getByRole('combobox', { name: /^Quality/ })).toHaveCount(0)
    healthy = true
    await notice.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('combobox', { name: /^Quality/ })).toHaveValue('1')
    await expect(page.getByRole('combobox', { name: /^Folder/ })).toHaveValue('/media')
    await expect(notice).toHaveCount(0)
  })
}
