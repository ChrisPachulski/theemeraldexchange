import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

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
