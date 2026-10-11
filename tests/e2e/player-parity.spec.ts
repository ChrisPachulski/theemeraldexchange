import { readFileSync } from 'fs'
import { test, expect, type Page } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Local-media (VOD) player parity with the Apple app: Up Next + binge gates,
// in-player episode navigation, Skip Intro, speed / info / settings, skip
// buttons, system media session, subtitle prefs, and the progressive decode
// error escalating to HLS. Every /api call is mocked; the stream is a real
// 60 s VP8 WebM (open codec, so the bundled Chromium decodes it), generated
// once with lavfi only:
//   ffmpeg -f lavfi -i "color=c=0x1f5f45:size=160x90:rate=5:duration=60" \
//     -c:v libvpx -b:v 10k -g 10 -pix_fmt yuv420p tests/fixtures/webm/episode-60s.webm

const WEBM = readFileSync('tests/fixtures/webm/episode-60s.webm')
const VTT = 'WEBVTT\n\n00:00.000 --> 01:00.000\nHello from the sidecar\n'
const SHOW = { id: 5, tmdb_id: 900, tvdb_id: 500, title: 'Test Show', year: 2020, added_at: '2026-01-01T00:00:00Z' }
const EPISODES = [1, 2, 3].map((n) => ({
  id: 100 + n,
  show_id: 5,
  season: 1,
  episode: n,
  title: `Chapter ${n}`,
  air_date: null,
  file_id: 200 + n,
}))
const SERIES = {
  id: 11,
  title: 'Test Show',
  tvdbId: 500,
  tmdbId: 900,
  year: 2020,
  status: 'ended',
  images: [],
  seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 3, totalEpisodeCount: 3, episodeFileCount: 3 } }],
  statistics: { seasonCount: 1, episodeCount: 3, totalEpisodeCount: 3, episodeFileCount: 3, sizeOnDisk: 0 },
  monitored: true,
  qualityProfileId: 1,
  rootFolderPath: '/tv',
  added: '2026-01-01T00:00:00Z',
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

type Grant = { id: number; body: Record<string, unknown> }

async function mockLibrary(
  page: Page,
  opts: { subtitle?: boolean; brokenStream?: boolean; markers?: boolean } = {},
): Promise<Grant[]> {
  const grants: Grant[] = []
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/limits', (r) => r.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, mediaEnabled: true })))
  await page.route('**/api/sonarr/api/v3/series', (r) => r.fulfill(json([SERIES])))
  await page.route('**/api/media/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const grant = p.match(/\/playback\/episode\/(\d+)$/)
    if (grant) {
      const id = Number(grant[1])
      grants.push({ id, body: route.request().postDataJSON() as Record<string, unknown> })
      const forced = grants[grants.length - 1].body.force_hls === true
      return route.fulfill(json({
        delivery: forced ? 'hls' : 'progressive',
        url: forced ? `/api/transcode/sess-${id}/index.m3u8?t=tok` : `/api/media/stream/episode/${id}?t=tok`,
        durationSecs: 60,
        subtitle: opts.subtitle ? { url: `/api/media/subs/${id}.vtt?t=tok`, language: 'eng', forced: false } : null,
      }))
    }
    if (p.startsWith('/api/media/stream/')) {
      if (opts.brokenStream) return route.fulfill({ status: 200, contentType: 'video/webm', body: 'not a video' })
      // Byte ranges, like the real stream route: without them the element
      // can't seek.
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
    if (p.startsWith('/api/media/subs/')) {
      return route.fulfill({ status: 200, contentType: 'text/vtt', headers: { 'Access-Control-Allow-Origin': '*' }, body: VTT })
    }
    if (p.endsWith('/shows/5/episodes')) return route.fulfill(json({ items: EPISODES }))
    if (p.endsWith('/shows')) return route.fulfill(json({ items: [SHOW], total: 1 }))
    if (p.endsWith('/movies')) return route.fulfill(json({ items: [], total: 0 }))
    if (p.endsWith('/markers')) {
      const intro = opts.markers && url.searchParams.get('media_id') === '101'
      return route.fulfill(json({ items: intro ? [{ marker_type: 'intro', start_secs: 0, end_secs: 20 }] : [] }))
    }
    if (p.endsWith('/watch')) return route.fulfill(json(route.request().method() === 'GET' ? { items: [] } : { ok: true }))
    return route.fulfill(json({}))
  })
  return grants
}

const player = (page: Page) => page.getByRole('dialog', { name: /Test Show/ })
const video = (page: Page) => page.getByTestId('iptv-player-video')
// Dev StrictMode runs the grant effect twice on mount, so compare the
// sequence of distinct episodes granted, not the raw request count.
const grantedIds = (grants: Grant[]) => grants.map((g) => g.id).filter((id, i, all) => id !== all[i - 1])

async function openEpisode(page: Page, code = 'S01E01') {
  await page.goto('/#/tv')
  await page.getByRole('tab', { name: /In library/ }).click()
  await page.getByRole('button', { name: /Test Show/ }).first().click()
  await page.getByRole('button', { name: 'Watch episodes here' }).click()
  await page.getByRole('button', { name: new RegExp(code) }).click()
  await expect(page.getByRole('group', { name: 'Playback controls' })).toBeVisible()
  // Playing: the clock has left 0:00.
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
}


test('Up Next arms in the last 30 s and Play now swaps the next episode into the same player', async ({ page }) => {
  const grants = await mockLibrary(page)
  await openEpisode(page)
  await player(page).evaluate((el) => {
    ;(window as unknown as { __modal: Element }).__modal = el
  })

  // Forward 30 lands inside the Up Next window of the 60 s episode.
  await page.getByRole('button', { name: 'Forward 30 seconds' }).click()
  const card = page.getByRole('group', { name: 'Up next' })
  await expect(card).toContainText('S01E02 · Chapter 2')
  await expect(card).toContainText(/Playing in \d+s/)

  await card.getByRole('button', { name: 'Play now' }).click()
  await expect(page.getByRole('heading', { name: 'Test Show — S01E02 · Chapter 2' })).toBeVisible()
  expect(grantedIds(grants)).toEqual([101, 102])
  // Swapped in place: the very same modal element hosts the new episode.
  expect(await player(page).evaluate((el) => el === (window as unknown as { __modal: Element }).__modal)).toBe(true)
})

// The third-unattended-advance gate is pinned in MediaPlayer.dom.test.tsx.
test('the countdown auto-advances, and 90 idle minutes pause on "Still watching?"', async ({ page }) => {
  await page.clock.install()
  const grants = await mockLibrary(page)
  await openEpisode(page)

  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 40
  })
  await expect(page.getByRole('group', { name: 'Up next' })).toBeVisible()
  await page.clock.runFor(12_000)
  await expect(page.getByRole('heading', { name: /S01E02/ })).toBeVisible()
  expect(grantedIds(grants)).toEqual([101, 102])

  // 90 minutes with no click or key while playing pauses on the idle gate.
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
  await page.clock.fastForward('01:31:00')
  await expect(page.getByRole('group', { name: 'Still watching?' })).toBeVisible()
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  await page.getByRole('button', { name: 'Keep watching' }).click()
  await expect(page.getByRole('group', { name: 'Still watching?' })).toBeHidden()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
})

test('previous/next buttons and the episode queue switch episodes in the player', async ({ page }) => {
  const grants = await mockLibrary(page)
  await openEpisode(page)
  const controls = page.getByRole('group', { name: 'Playback controls' })
  await expect(controls.getByRole('button', { name: 'Previous episode' })).toBeDisabled()

  await controls.getByRole('button', { name: 'Episodes' }).click()
  const queue = page.getByRole('group', { name: 'Episodes' })
  await expect(queue).toBeVisible()
  await expect(queue.locator('[aria-current="true"]')).toContainText('S01E01')
  // Escape closes just the popover, not the player.
  await page.keyboard.press('Escape')
  await expect(queue).toBeHidden()
  await expect(player(page)).toBeVisible()

  await controls.getByRole('button', { name: 'Episodes' }).click()
  await queue.getByRole('button', { name: /S01E03/ }).click()
  await expect(page.getByRole('heading', { name: /S01E03/ })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Playback controls' }).getByRole('button', { name: 'Next episode' })).toBeDisabled()

  await page.getByRole('group', { name: 'Playback controls' }).getByRole('button', { name: 'Previous episode' }).click()
  await expect(page.getByRole('heading', { name: /S01E02/ })).toBeVisible()
  expect(grantedIds(grants)).toEqual([101, 103, 102])
})

test('Skip Intro seeks past the intro marker', async ({ page }) => {
  await mockLibrary(page, { markers: true })
  await openEpisode(page)
  const skip = page.getByRole('button', { name: 'Skip Intro' })
  await expect(skip).toBeVisible()
  await skip.click()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(20)
  await expect(skip).toBeHidden()
})

test('skip buttons, speed, info, media session and picture-in-picture', async ({ page }) => {
  await mockLibrary(page)
  await openEpisode(page)
  const controls = page.getByRole('group', { name: 'Playback controls' })

  await controls.getByRole('button', { name: 'Forward 30 seconds' }).click()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(30)
  await controls.getByRole('button', { name: 'Back 10 seconds' }).click()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(30)

  await controls.getByRole('button', { name: 'Playback settings' }).click()
  const settings = page.getByRole('group', { name: 'Playback settings' })
  await expect(settings).toContainText('Direct play')
  await expect(settings).toContainText('160×90')
  await settings.getByRole('combobox', { name: 'Speed' }).selectOption('1.5')
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5)
  await page.keyboard.press('Escape')

  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Test Show — S01E01 · Chapter 1')
  const pip = await page.evaluate(() => document.pictureInPictureEnabled)
  await expect(controls.getByRole('button', { name: 'Picture in picture' })).toHaveCount(pip ? 1 : 0)

  // Speed is persisted and survives the in-place episode swap.
  await controls.getByRole('button', { name: 'Next episode' }).click()
  await expect(page.getByRole('heading', { name: /S01E02/ })).toBeVisible()
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5)
})

test('autoplay off (player settings) suppresses Up Next', async ({ page }) => {
  await mockLibrary(page)
  await openEpisode(page)
  await page.getByRole('button', { name: 'Playback settings' }).click()
  await page.getByRole('group', { name: 'Playback settings' }).getByRole('checkbox', { name: 'Autoplay next episode' }).uncheck()
  await page.keyboard.press('Escape')
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 40
  })
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(40)
  await expect(page.getByRole('group', { name: 'Up next' })).toHaveCount(0)
})

test('account Playback settings: "Always" subtitles and appearance apply in the player', async ({ page }) => {
  await mockLibrary(page, { subtitle: true })
  await page.goto('/#/tv')
  await page.getByRole('button', { name: /Someone/ }).click()
  await page.getByText('Playback', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Subtitles', exact: true }).selectOption('always')
  await page.getByRole('combobox', { name: 'Subtitle size' }).selectOption('large')
  await page.getByRole('combobox', { name: 'Subtitle color' }).selectOption('yellow')
  await page.keyboard.press('Escape')

  await openEpisode(page)
  await expect
    .poll(() => video(page).evaluate((v: HTMLVideoElement) => v.textTracks[0]?.mode))
    .toBe('showing')
  await expect(page.getByRole('button', { name: 'Turn off subtitles' })).toBeVisible()
  const vars = await player(page).evaluate((el) => {
    const s = getComputedStyle(el)
    return [el.hasAttribute('data-subtitle-style'), s.getPropertyValue('--cue-size'), s.getPropertyValue('--cue-color')]
  })
  expect(vars).toEqual([true, '140%', 'rgb(255 214 0)'])

  // Turning CC off is remembered for the show: the next episode opens with it off.
  await page.getByRole('button', { name: 'Turn off subtitles' }).click()
  await page.getByRole('button', { name: 'Next episode' }).click()
  await expect(page.getByRole('heading', { name: /S01E02/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Turn on subtitles' })).toBeVisible()
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.textTracks[0]?.mode)).not.toBe('showing')
})

test('a progressive file the browser cannot decode re-grants with forced HLS', async ({ page }) => {
  const grants = await mockLibrary(page, { brokenStream: true })
  await page.goto('/#/tv')
  await page.getByRole('tab', { name: /In library/ }).click()
  await page.getByRole('button', { name: /Test Show/ }).first().click()
  await page.getByRole('button', { name: 'Watch episodes here' }).click()
  await page.getByRole('button', { name: /S01E01/ }).click()
  await expect.poll(() => grants.filter((g) => g.id === 101 && g.body.force_hls === true).length).toBe(1)
})
