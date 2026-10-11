import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// YouTube + Music library tabs (Apple YouTubeScreen / MusicScreen parity):
// gated on /api/limits, browse via /api/media/{youtube,music}/*, and play
// through the shared MediaPlayer with kind 'video' / 'track'.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

async function setup(page: Page, limits: Record<string, unknown>) {
  await installBackgroundMocks(page)
  // Registered after the background catch-all so this one wins.
  await page.route('**/api/limits', (route) => route.fulfill(json({ maxMovieGb: 10, ...limits })))
  await mockMe(page, ADMIN_USER)
}

const video = (id: number, channel: string, title: string) => ({
  id,
  channel,
  title,
  upload_date: '2026-10-01',
  description: null,
  duration_secs: 612,
  thumbUrl: `/api/media/youtube/videos/${id}/thumb`,
})

test('library tabs stay hidden unless the server reports the library', async ({ page }) => {
  await setup(page, {})
  await page.goto('/#/home')
  const sections = page.getByRole('navigation', { name: 'Sections' })
  await expect(sections.getByRole('button', { name: 'Movies' })).toBeVisible()
  await expect(sections.getByRole('button', { name: 'YouTube' })).toHaveCount(0)
  await expect(sections.getByRole('button', { name: 'Music' })).toHaveCount(0)

  // Stale deep links bounce home once the real limits arrive.
  await page.goto('/#/youtube')
  await expect(page).toHaveURL(/#\/home$/)
  await page.goto('/#/music')
  await expect(page).toHaveURL(/#\/home$/)
})

test('YouTube tab shows Latest + channel rows and plays a video as kind video', async ({ page }) => {
  await setup(page, { youtubeEnabled: true })
  const playback: string[] = []
  await page.route('**/api/media/**', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p === '/api/media/youtube/channels') {
      return route.fulfill(json({ items: [{ name: 'PBS', video_count: 1, latest_upload: '2026-10-01' }, { name: 'Empty' }] }))
    }
    if (p === '/api/media/youtube/videos') {
      const channel = url.searchParams.get('channel')
      const items =
        channel === null ? [video(9, 'PBS', 'Deep Sea Life')] : channel === 'PBS' ? [video(9, 'PBS', 'Deep Sea Life')] : []
      return route.fulfill(json({ items, total: items.length }))
    }
    if (p.endsWith('/thumb')) return route.fulfill({ status: 404, body: '' })
    if (p.startsWith('/api/media/playback/')) {
      playback.push(p)
      return route.fulfill(json({ delivery: 'progressive', url: '/api/media/stream/video/9?t=tok', durationSecs: 612 }))
    }
    if (p.startsWith('/api/media/stream/')) return route.fulfill({ status: 404, body: '' })
    return route.fulfill(json({ items: [] }))
  })

  await page.goto('/#/home')
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'YouTube' }).click()
  await expect(page).toHaveURL(/#\/youtube$/)

  const latest = page.getByRole('region', { name: 'Latest' })
  await expect(latest).toBeVisible()
  await expect(page.getByRole('region', { name: 'PBS' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Empty' })).toHaveCount(0)

  const card = latest.getByRole('button', { name: /Deep Sea Life/ })
  await expect(card).toContainText('Oct 1, 2026 · 10:12')
  await expect(card.locator('img')).toHaveAttribute('src', /\/api\/media\/youtube\/videos\/9\/thumb$/)

  const stream = page.waitForRequest((r) => r.url().includes('/api/media/stream/video/9?t=tok'))
  await card.click()
  await stream
  // Dedupe: dev StrictMode mounts the player's session effect twice.
  expect([...new Set(playback)]).toEqual(['/api/media/playback/video/9'])
  await expect(page.getByRole('dialog', { name: 'Deep Sea Life' })).toBeVisible()
})

test('Music tab drills Artists -> Albums -> Tracks, retries a failed level, and plays a track', async ({ page }) => {
  await setup(page, { musicEnabled: true })
  const playback: string[] = []
  let albumsCalls = 0
  await page.route('**/api/media/**', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p === '/api/media/music/artists') {
      return route.fulfill(json({ items: [{ id: 1, name: 'Boards of Canada', album_count: 1 }], total: 1 }))
    }
    if (p === '/api/media/music/albums') {
      // The first load and the query client's one automatic retry fail, so
      // the error-with-retry state is exercised.
      if (albumsCalls++ < 2) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
      expect(url.searchParams.get('artist_id')).toBe('1')
      return route.fulfill(json({
        items: [{ id: 7, artist_id: 1, artist_name: 'Boards of Canada', title: 'Geogaddi', year: 2002, track_count: 2, art_url: '/api/media/music/albums/7/art' }],
        total: 1,
      }))
    }
    if (p === '/api/media/music/tracks') {
      expect(url.searchParams.get('album_id')).toBe('7')
      return route.fulfill(json({
        items: [
          { id: 70, album_id: 7, title: 'Ready Lets Go', track_no: 1, duration_secs: 59 },
          { id: 71, album_id: 7, title: 'Music Is Math', track_no: 2, duration_secs: 321 },
        ],
        total: 2,
      }))
    }
    if (p.endsWith('/art')) return route.fulfill({ status: 404, body: '' })
    if (p.startsWith('/api/media/playback/')) {
      playback.push(p)
      return route.fulfill(json({ delivery: 'progressive', url: '/api/media/stream/track/71?t=tok', durationSecs: 321 }))
    }
    if (p.startsWith('/api/media/stream/')) return route.fulfill({ status: 404, body: '' })
    return route.fulfill(json({ items: [] }))
  })

  await page.goto('/#/home')
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Music' }).click()
  await expect(page).toHaveURL(/#\/music$/)

  await page.getByRole('list', { name: 'Artists' }).getByRole('button', { name: /Boards of Canada.*1 album$/ }).click()
  await expect(page.getByRole('alert')).toContainText("Couldn't load albums.")
  await page.getByRole('button', { name: 'Retry' }).click()

  const album = page.getByRole('list', { name: 'Albums' }).getByRole('button', { name: /Geogaddi/ })
  await expect(album).toContainText('2002 · 2 tracks')
  await expect(album.locator('img')).toHaveAttribute('src', /\/api\/media\/music\/albums\/7\/art$/)
  await album.click()

  await expect(page.getByRole('heading', { name: 'Geogaddi' })).toBeVisible()
  const track = page.getByRole('list', { name: 'Tracks' }).getByRole('button', { name: /Music Is Math/ })
  await expect(track).toContainText('Track 2 · 5:21')

  const stream = page.waitForRequest((r) => r.url().includes('/api/media/stream/track/71?t=tok'))
  await track.click()
  await stream
  expect([...new Set(playback)]).toEqual(['/api/media/playback/track/71'])
  await expect(page.getByRole('dialog', { name: 'Boards of Canada — Music Is Math' })).toBeVisible()
  await page.getByRole('button', { name: 'Close player' }).click()

  // Crumbs walk back up the drill.
  await page.getByRole('navigation', { name: 'Music library' }).getByRole('button', { name: 'Boards of Canada' }).click()
  await expect(page.getByRole('list', { name: 'Albums' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Music library' }).getByRole('button', { name: 'Artists' }).click()
  await expect(page.getByRole('list', { name: 'Artists' })).toBeVisible()
})
