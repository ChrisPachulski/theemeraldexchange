import { readFileSync } from 'fs'
import { test, expect } from '@playwright/test'
import { ADMIN_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Guards the whole web live path: guide click -> grant -> IptvPlayer -> hls.js
// loadSource. From 2026-08-27 to 2026-09-29 every live channel on the web died
// between the grant and the manifest request (hls.js threw on a config that
// mixed liveSyncDurationCount with liveSyncDuration) while CI stayed green,
// because no spec ever played a live channel through the real player. The
// assertion is "the manifest is requested and the page raised no error", which
// is codec-independent and so holds on the bundled Chromium.

const FIXTURE_DIR = 'tests/fixtures/hls'
const STREAM_ID = 200158440
const CHANNEL = 'CA: Sportsnet Ontario'

test('playing a live channel requests its manifest with no page error', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  const now = Date.now()
  const programme = {
    channel_id: 'sportsnetontario.ca',
    start_utc: new Date(now - 30 * 60_000).toISOString(),
    stop_utc: new Date(now + 90 * 60_000).toISOString(),
    title: 'NHL Hockey',
    description: null,
  }
  const channel = {
    stream_id: STREAM_ID, num: 110, name: CHANNEL, stream_icon: null,
    epg_channel_id: 'sportsnetontario.ca', category_id: 21, tv_archive: 0, tv_archive_duration: 0,
  }
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/iptv/**', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.endsWith('/grant')) {
      return route.fulfill(json({
        url: `/api/iptv/stream/live/${STREAM_ID}/remux/index.m3u8?t=tok`,
        delivery: 'hls',
        sessionId: `live:${STREAM_ID}:plex:1:${Date.now()}`,
      }))
    }
    if (p.endsWith('index.m3u8')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: readFileSync(`${FIXTURE_DIR}/index.m3u8`, 'utf-8'),
      })
    }
    if (p.includes('seg_')) {
      return route.fulfill({ status: 200, contentType: 'video/mp2t', body: readFileSync(`${FIXTURE_DIR}/${p.split('/').pop()}`) })
    }
    if (p.endsWith('/categories')) return route.fulfill(json([{ category_id: 21, name: 'CA: Sports', parent_id: 0 }]))
    if (p.endsWith('/live')) return route.fulfill(json({ items: [channel], total: 1, limit: 100, offset: 0 }))
    if (p.endsWith('/epg/grid')) return route.fulfill(json([{ ...channel, programmes: [programme] }]))
    if (p.endsWith('/epg/now')) return route.fulfill(json([{ channel_stream_id: STREAM_ID, current: programme, next: null }]))
    if (p.endsWith('/sessions')) return route.fulfill(json({ sessions: [], max: 2 }))
    if (p.endsWith('/favorites')) return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
  await page.route('**/api/limits', (route) => route.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, iptvEnabled: true })))
  await installBackgroundMocks(page)
  await mockMe(page, ADMIN_USER)

  await page.goto('/#/live')
  const manifest = page.waitForRequest((r) => r.url().includes(`/live/${STREAM_ID}/remux/index.m3u8`))
  await page.getByTitle(`Watch ${CHANNEL} live`).first().click()
  await manifest
  expect(pageErrors).toEqual([])
})
