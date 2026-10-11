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

  // A stale deep link bounces home once the real limits arrive.
  await page.goto('/#/youtube')
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
