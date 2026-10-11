import { readFileSync } from 'fs'
import { test, expect, type Page, type Route } from '@playwright/test'
import { ADMIN_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Live TV parity with the Apple app (the live lane): guide curation, favorites,
// programme filter, retry states, the channel schedule, the live player's
// reconnect / offline / mini-guide machinery, library search, connection
// errors and the one-grant-per-tap guard. Every /api call is mocked.

const FIXTURE_DIR = 'tests/fixtures/hls'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

type Programme = { channel_id: string; start_utc: string; stop_utc: string; title: string; description: string | null }

function programme(channel: string, title: string, fromMin: number, toMin: number, description: string | null = null): Programme {
  const now = Date.now()
  return {
    channel_id: channel,
    start_utc: new Date(now + fromMin * 60_000).toISOString(),
    stop_utc: new Date(now + toMin * 60_000).toISOString(),
    title,
    description,
  }
}

function channel(stream_id: number, name: string, extra: { tv_archive?: number; stream_icon?: string | null } = {}) {
  return {
    stream_id,
    num: stream_id,
    name,
    stream_icon: extra.stream_icon ?? null,
    epg_channel_id: name,
    category_id: 21,
    tv_archive: extra.tv_archive ?? 0,
    tv_archive_duration: extra.tv_archive ? 3 : null,
  }
}

const ABC = channel(101, 'US ABC', { stream_icon: PNG })
const CBS = channel(102, 'US CBS', { tv_archive: 1 })
const GRID = [
  { ...ABC, programmes: [programme('US ABC', 'NBA: Celtics at Knicks', -20, 100)] },
  { ...CBS, programmes: [programme('US CBS', 'Evening News', -20, 40)] },
]

type Handler = (url: URL, route: Route) => Promise<void> | void | false

// Background mocks first (they sit at the bottom of Playwright's reverse-order
// chain), then a single /api/iptv router: `handle` gets first refusal, anything
// it returns `false` for falls through to the defaults below.
async function setup(page: Page, handle: Handler = () => false, favorites: number[] = []) {
  await installBackgroundMocks(page)
  await mockMe(page, ADMIN_USER)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, iptvEnabled: true, mediaEnabled: true })),
  )
  // Live search also queries the library; an empty one unless a test overrides it.
  await page.route('**/api/media/**', (route) => route.fulfill(json({ items: [], total: 0 })))
  const grants: string[] = []
  const kills: string[] = []
  await page.route('**/api/iptv/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const method = route.request().method()
    if (p.endsWith('/grant')) grants.push(p)
    if (method === 'DELETE' && p.includes('/sessions/')) kills.push(decodeURIComponent(p.split('/').pop() ?? ''))
    const handled = await handle(url, route)
    if (handled !== false) return
    if (p.endsWith('/grant')) {
      const id = p.split('/').at(-2)
      return route.fulfill(json({ url: `/api/iptv/stream/live/${id}/remux/index.m3u8?t=tok`, delivery: 'hls', sessionId: `live:${id}` }))
    }
    if (p.endsWith('index.m3u8')) {
      return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: readFileSync(`${FIXTURE_DIR}/index.m3u8`, 'utf-8') })
    }
    if (p.includes('seg_')) {
      return route.fulfill({ status: 200, contentType: 'video/mp2t', body: readFileSync(`${FIXTURE_DIR}/${p.split('/').pop()}`) })
    }
    if (p.endsWith('/categories')) {
      return route.fulfill(json([
        { category_id: 21, name: 'US| Sports', parent_id: 0 },
        { category_id: 22, name: 'XXX Adult', parent_id: 0 },
        { category_id: 23, name: 'UK| News', parent_id: 0 },
      ]))
    }
    if (p.endsWith('/live')) return route.fulfill(json({ items: [ABC, CBS], total: 2, limit: 100, offset: 0 }))
    if (p.endsWith('/epg/grid')) return route.fulfill(json(url.searchParams.get('q') ? [] : GRID))
    if (p.endsWith('/epg/now')) return route.fulfill(json([]))
    if (p.endsWith('/epg/search')) return route.fulfill(json({ hits: [], total: 0 }))
    if (p.endsWith('/sessions')) {
      return route.fulfill(json({ self: 'plex:1001', upstream: { activeConnections: 0, maxConnections: 2, status: 'Active' }, ours: [] }))
    }
    if (p.endsWith('/favorites') && method === 'GET') {
      return route.fulfill(json(favorites.map((id) => ({ sub: 'plex:1001', kind: 'live', item_id: String(id), added_ts: '2026-10-01T00:00:00Z' }))))
    }
    if (method === 'DELETE') return route.fulfill({ status: 204, body: '' })
    return route.fulfill(json({}))
  })
  return { grants, kills }
}

const channelCells = (page: Page) => page.locator('.epg-guide__chan-play')

test('guide: adult categories hidden, favorites pinned and starred, logo and catch-up chip', async ({ page }) => {
  const gridScopes: string[] = []
  const favoritePosts: unknown[] = []
  await setup(page, (url, route) => {
    if (url.pathname.endsWith('/epg/grid')) gridScopes.push(url.searchParams.get('categoryIds') ?? '')
    if (url.pathname.endsWith('/favorites') && route.request().method() === 'POST') {
      favoritePosts.push(route.request().postDataJSON())
      return route.fulfill(json({}))
    }
    return false
  }, [CBS.stream_id])
  await page.goto('/#/live')

  await expect(channelCells(page).first()).toHaveAttribute('title', 'Watch US CBS live')
  await expect(channelCells(page).nth(1)).toHaveAttribute('title', 'Watch US ABC live')
  // The default scope is the US+sports set only: the adult category never loads.
  expect(gridScopes).toContain('21')
  await expect(page.locator('select.iptv-tab__category option')).toHaveText(['All categories', 'UK| News', 'US| Sports'])

  await expect(page.getByTitle('Watch US ABC live').locator('img.epg-guide__chan-logo')).toHaveAttribute('src', PNG)
  await expect(page.getByTitle('Watch US CBS live').getByRole('img', { name: 'Catch-up available' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unfavorite US CBS' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Favorite US ABC' }).click()
  await expect.poll(() => favoritePosts).toContainEqual({ kind: 'live', itemId: String(ABC.stream_id) })
})

test('guide search keeps channels airing a matching programme', async ({ page }) => {
  await setup(page)
  await page.goto('/#/live')
  await expect(page.getByTitle('Watch US CBS live')).toBeVisible()

  await page.getByPlaceholder('Search channels and programs…').fill('celtics')
  await expect(page.getByTitle('Watch US ABC live')).toBeVisible()
  await expect(page.getByTitle('Watch US CBS live')).toHaveCount(0)
})

test('a failed guide load offers Retry, which recovers the grid', async ({ page }) => {
  let failures = 0
  await setup(page, (url, route) => {
    // Two failures: the query client retries once before surfacing an error.
    if (url.pathname.endsWith('/epg/grid') && failures < 2) {
      failures += 1
      return route.fulfill(json({ error: 'boom' }, 502))
    }
    return false
  })
  await page.goto('/#/live')

  await expect(page.getByRole('alert')).toContainText('Couldn’t load the guide.')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTitle('Watch US ABC live')).toBeVisible()
})

test('the Favorites view lists starred channels and plays one', async ({ page }) => {
  const { grants } = await setup(page, () => false, [CBS.stream_id])
  await page.goto('/#/live')
  await expect(page.getByTitle('Watch US CBS live')).toBeVisible()

  await page.getByRole('button', { name: 'Favorites' }).click()
  const card = page.locator('li.iptv-channel-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('US CBS')
  await expect(card).toContainText('Catch-up')
  await card.click()
  await expect.poll(() => grants).toContain(`/api/iptv/stream/live/${CBS.stream_id}/grant`)
})

test('a programme hit opens the real channel’s schedule on the matched programme', async ({ page }) => {
  const NBC = channel(300, 'US NBC', { tv_archive: 1 })
  const upcoming = programme('US NBC', 'Sunday Night Football', 120, 300, 'Chiefs at Bills')
  const resolveQueries: string[] = []
  const { grants } = await setup(page, (url, route) => {
    const p = url.pathname
    if (p.endsWith('/epg/search')) {
      return route.fulfill(json({ total: 1, hits: [{ streamId: 300, channelName: 'US NBC', categoryId: 21, programIndex: 2, programme: upcoming }] }))
    }
    if (p.endsWith('/live') && url.searchParams.get('q') === 'US NBC') {
      resolveQueries.push('US NBC')
      return route.fulfill(json({ items: [NBC], total: 1, limit: 100, offset: 0 }))
    }
    if (p.endsWith('/epg/channel/300')) {
      return route.fulfill(json([
        programme('US NBC', 'Morning Show', -180, -60),
        programme('US NBC', 'Afternoon Live', -20, 60, 'Talk and interviews'),
        upcoming,
      ]))
    }
    return false
  })
  await page.goto('/#/live')
  await page.getByPlaceholder('Search channels and programs…').fill('football')
  await page.getByRole('button', { name: /Sunday Night Football/ }).click()

  const dialog = page.getByRole('dialog', { name: 'US NBC guide' })
  await expect(dialog).toBeVisible()
  expect(resolveQueries).toEqual(['US NBC'])
  await expect(dialog.locator('.iptv-guide-list__item--selected')).toContainText('Sunday Night Football')
  await expect(dialog.locator('.iptv-guide-list__item--selected')).toContainText('Chiefs at Bills')
  // The resolved channel carries an archive, so the past programme offers catch-up.
  await expect(dialog.getByRole('button', { name: 'Catchup' })).toBeVisible()
  await expect(dialog).toContainText('Talk and interviews')

  await dialog.getByRole('button', { name: 'Watch live' }).click()
  await expect.poll(() => grants).toContain('/api/iptv/stream/live/300/grant')
})

test('a swept live session reconnects with a fresh grant behind a Reconnecting cover', async ({ page }) => {
  let grantCount = 0
  const manifests: string[] = []
  const { kills } = await setup(page, (url, route) => {
    const p = url.pathname
    if (p.endsWith('/grant')) {
      grantCount += 1
      return route.fulfill(json({
        url: `/api/iptv/stream/live/${ABC.stream_id}/remux/index.m3u8?t=g${grantCount}`,
        delivery: 'hls',
        sessionId: `live:${ABC.stream_id}:g${grantCount}`,
      }))
    }
    if (p.endsWith('index.m3u8')) {
      const t = url.searchParams.get('t') ?? ''
      manifests.push(t)
      if (t === 'g1') return route.fulfill(json({ error: 'session_gone' }, 410))
    }
    return false
  })
  await page.goto('/#/live')
  await page.getByTitle('Watch US ABC live').click()

  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting… (1 of 5)' })).toBeVisible()
  await expect.poll(() => manifests, { timeout: 10_000 }).toContain('g2')
  // The swept session was released before re-dialing.
  expect(kills).toContain(`live:${ABC.stream_id}:g1`)
  expect(grantCount).toBe(2)
})

test('an off-air channel shows Channel offline instead of a dead end', async ({ page }) => {
  test.setTimeout(60_000)
  const { kills } = await setup(page, (url, route) => {
    if (url.pathname.endsWith('index.m3u8')) {
      return route.fulfill(json({ error: 'channel_offline_upstream' }, 503))
    }
    return false
  })
  await page.goto('/#/live')
  await page.getByTitle('Watch US ABC live').click()

  // hls.js retries a 503 manifest a few times before surfacing it (~11 s); if
  // the first round loses the body to an aborted XHR, the player reloads the
  // source and a second round runs (~24 s), slower still on a loaded runner.
  const card = page.getByRole('alert').filter({ hasText: 'Channel offline' })
  await expect(card).toBeVisible({ timeout: 45_000 })
  expect(kills).toContain(`live:${ABC.stream_id}`)
  await card.getByRole('button', { name: 'Open guide' }).click()
  await expect(page.getByRole('region', { name: 'Channel guide' })).toBeVisible()
})

test('the in-player guide surfs channels from the cached grid', async ({ page }) => {
  let gridFetches = 0
  const { grants } = await setup(page, (url) => {
    if (url.pathname.endsWith('/epg/grid')) gridFetches += 1
    return false
  })
  await page.goto('/#/live')
  await page.getByTitle('Watch US ABC live').click()
  const player = page.getByRole('dialog', { name: 'US ABC' })
  await expect(player).toBeVisible()
  const fetchesBefore = gridFetches

  await player.press('g')
  const strip = page.getByRole('region', { name: 'Channel guide' })
  await expect(strip.getByRole('button', { name: /US CBS/ })).toContainText('Evening News')
  expect(gridFetches).toBe(fetchesBefore)

  await strip.getByTitle('Switch to US CBS').click()
  await expect.poll(() => grants).toContain(`/api/iptv/stream/live/${CBS.stream_id}/grant`)
  await expect(page.getByRole('dialog', { name: 'US CBS' })).toBeVisible()
})

test('library movies show in the Live search and play in the media player', async ({ page }) => {
  const playbacks: string[] = []
  await setup(page)
  await page.route('**/api/media/**', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p.endsWith('/movies')) {
      return route.fulfill(json({
        items: url.searchParams.get('q') === 'heat'
          ? [{ id: 7, tmdb_id: 949, imdb_id: null, title: 'Heat', year: 1995, added_at: '2026-01-01', file_id: 70 }]
          : [],
        total: 1,
      }))
    }
    if (p.endsWith('/shows')) return route.fulfill(json({ items: [], total: 0 }))
    if (p.endsWith('/watch')) return route.fulfill(json({ items: [] }))
    if (p.includes('/playback/')) {
      playbacks.push(p)
      return route.fulfill(json({ delivery: 'progressive', url: '/api/media/stream/7?t=tok', durationSecs: 6000 }))
    }
    return route.fulfill(json({}))
  })
  await page.goto('/#/live')
  await page.getByPlaceholder('Search channels and programs…').fill('heat')

  const movies = page.getByRole('region', { name: 'Library Movies' })
  await movies.getByRole('button', { name: /Heat/ }).click()
  await expect.poll(() => playbacks).toContain('/api/media/playback/movie/7')
})

test('connections: a failed load offers Retry and a failed kick says so', async ({ page }) => {
  // Loads fail until Retry is pressed (not on a count: the widget also polls).
  let sessionsUp = false
  await setup(page, (url, route) => {
    const p = url.pathname
    if (p.endsWith('/sessions') && route.request().method() === 'GET') {
      if (!sessionsUp) return route.fulfill(json({ error: 'boom' }, 502))
      return route.fulfill(json({
        self: 'plex:1001',
        upstream: { activeConnections: 1, maxConnections: 2, status: 'Active' },
        ours: [{ sessionId: 's-1', sub: 'plex:1001', kind: 'live', resourceId: '101', title: 'US ABC', resolvedTitle: 'US ABC', ip: null, startedAt: Date.now(), lastSeen: Date.now() }],
      }))
    }
    if (p.endsWith('/sessions/s-1')) return route.fulfill(json({ error: 'boom' }, 502))
    return false
  })
  await page.goto('/#/live')
  await page.getByRole('button', { name: 'Connections' }).click()
  const panel = page.getByRole('dialog', { name: 'Active connections' })

  await expect(panel.getByRole('alert')).toContainText('Couldn’t load the connections.')
  sessionsUp = true
  await panel.getByRole('button', { name: 'Retry' }).click()
  await expect(panel).toContainText('US ABC')
  await panel.getByRole('button', { name: 'Kick' }).click()
  await expect(panel.getByRole('alert')).toContainText('Couldn’t free a slot.')
})

test('a double click mints one grant, not two', async ({ page }) => {
  // A slow grant keeps the first tap in flight while the second lands.
  const { grants } = await setup(page, async (url) => {
    if (url.pathname.endsWith('/grant')) await new Promise((resolve) => setTimeout(resolve, 600))
    return false
  })
  await page.goto('/#/live')
  await page.getByTitle('Watch US ABC live').dblclick()
  await expect(page.getByRole('dialog', { name: 'US ABC' })).toBeVisible()
  expect(grants).toHaveLength(1)
})
