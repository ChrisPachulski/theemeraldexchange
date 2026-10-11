import { readFileSync } from 'fs'
import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Media-server lane parity (Apple app): channel name + logo on Home's On now
// tiles, the Chapters list in the player settings, and the Quality cap.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

async function setup(page: Page, limits: Record<string, unknown> = {}) {
  await installBackgroundMocks(page)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, iptvEnabled: false, mediaEnabled: false, ...limits })),
  )
  await page.route('**/api/recommender/event', (route) => route.fulfill(json({})))
  await mockMe(page, ADMIN_USER)
}

test('On now tiles name the channel with its logo, and the player is titled with it', async ({ page }) => {
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
    if (p.endsWith('/epg/now')) {
      return route.fulfill(json([{
        channel_stream_id: 300001, name: 'TSN 4', stream_icon: 'https://logos.example/tsn4.png', current: programme, next: null,
      }]))
    }
    if (p.endsWith('/grant')) return route.fulfill(json({ url: '/api/iptv/stream/live/300001/remux/index.m3u8?t=tok', delivery: 'hls' }))
    if (p.endsWith('/live')) return route.fulfill(json({ items: [], total: 0, limit: 100, offset: 0 }))
    if (p.endsWith('/sessions')) return route.fulfill(json({ sessions: [], max: 2 }))
    if (p.endsWith('/categories') || p.endsWith('/epg/grid')) return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
  await page.route('https://logos.example/**', (route) => route.fulfill({ status: 404 }))

  await page.goto('/#/home')
  const tile = page.getByRole('region', { name: 'On now' }).getByRole('button', { name: /NHL Hockey/ })
  await expect(tile).toContainText('TSN 4')
  await expect(tile).toContainText(/On now · (39|40)m left/)
  await expect(tile.locator('img.home-live-tile__logo')).toHaveAttribute('src', 'https://logos.example/tsn4.png')

  await tile.click()
  await expect(page.getByRole('dialog', { name: 'TSN 4' })).toBeVisible()
})

// ── Local-media player: a real 60 s VP8 WebM (see player-parity.spec.ts) ──

const WEBM = readFileSync('tests/fixtures/webm/episode-60s.webm')
const SHOW = { id: 5, tmdb_id: 900, tvdb_id: 500, title: 'Test Show', year: 2020, added_at: '2026-01-01T00:00:00Z' }
const EPISODE = { id: 101, show_id: 5, season: 1, episode: 1, title: 'Pilot', air_date: null, file_id: 201 }
const SERIES = {
  id: 11, title: 'Test Show', tvdbId: 500, tmdbId: 900, year: 2020, status: 'ended', images: [],
  seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 1, totalEpisodeCount: 1, episodeFileCount: 1 } }],
  statistics: { seasonCount: 1, episodeCount: 1, totalEpisodeCount: 1, episodeFileCount: 1, sizeOnDisk: 0 },
  monitored: true, qualityProfileId: 1, rootFolderPath: '/tv', added: '2026-01-01T00:00:00Z',
}
const CHAPTERS = [
  { title: 'Cold open', start_secs: 0, end_secs: 25 },
  { title: null, start_secs: 40, end_secs: 60 },
]

/** Mocks the library + a progressive episode; returns every grant body. */
async function mockEpisode(page: Page): Promise<Record<string, unknown>[]> {
  const grants: Record<string, unknown>[] = []
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/limits', (r) => r.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, mediaEnabled: true })))
  await page.route('**/api/sonarr/api/v3/series', (r) => r.fulfill(json([SERIES])))
  await page.route('**/api/media/**', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.endsWith('/playback/episode/101')) {
      grants.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill(json({ delivery: 'progressive', url: '/api/media/stream/episode/101?t=tok', durationSecs: 60 }))
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
    if (p.endsWith('/chapters/episode/101')) return route.fulfill(json({ items: CHAPTERS }))
    if (p.endsWith('/shows/5/episodes')) return route.fulfill(json({ items: [EPISODE] }))
    if (p.endsWith('/shows')) return route.fulfill(json({ items: [SHOW], total: 1 }))
    if (p.endsWith('/movies')) return route.fulfill(json({ items: [], total: 0 }))
    if (p.endsWith('/markers')) return route.fulfill(json({ items: [] }))
    if (p.endsWith('/watch')) return route.fulfill(json(route.request().method() === 'GET' ? { items: [] } : { ok: true }))
    return route.fulfill(json({}))
  })
  return grants
}

const video = (page: Page) => page.getByTestId('iptv-player-video')

async function openEpisode(page: Page) {
  await page.goto('/#/tv')
  await page.getByRole('tab', { name: /In library/ }).click()
  await page.getByRole('button', { name: /Test Show/ }).first().click()
  await page.getByRole('button', { name: 'Play S1E1' }).click()
  await expect(page.getByRole('group', { name: 'Playback controls' })).toBeVisible()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
}

test('the settings popover lists the file\'s chapters and a pick seeks there', async ({ page }) => {
  await mockEpisode(page)
  await openEpisode(page)

  await page.getByRole('button', { name: 'Playback settings' }).click()
  const chapters = page.getByRole('region', { name: 'Chapters' })
  await expect(chapters.getByRole('button')).toHaveText([/Cold open\s*0:00/, /Chapter 2\s*0:40/])

  await chapters.getByRole('button', { name: /Chapter 2/ }).click()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(40)
  // The pick closes the popover.
  await expect(chapters).toBeHidden()
})
