import { readFileSync } from 'fs'
import { test, expect, type Page, type Route } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER, installBackgroundMocks, mockMe, type MockUser } from './helpers/mockApi'

// DVR parity with the Apple app (the dvr lane): future-programme details and
// Record from the guide, the Recordings panel (list, detail, play, delete), and
// the opt-in muted live preview in the guide's detail pane. DVR surfaces exist
// only when /api/limits says dvrEnabled. Every /api call is mocked.

const FIXTURE_DIR = 'tests/fixtures/hls'

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

function programme(channel: string, title: string, fromMin: number, toMin: number, description: string | null = null) {
  const now = Date.now()
  return {
    channel_id: channel,
    start_utc: new Date(now + fromMin * 60_000).toISOString(),
    stop_utc: new Date(now + toMin * 60_000).toISOString(),
    title,
    description,
  }
}

const ABC = { stream_id: 101, num: 101, name: 'US ABC', stream_icon: null, epg_channel_id: 'US ABC', category_id: 21, tv_archive: 0, tv_archive_duration: null }
const LIVE = programme('US ABC', 'Morning Live', -20, 40)
const FUTURE = programme('US ABC', 'Evening Movie', 40, 100, 'A heist goes wrong.')
const GRID = [{ ...ABC, programmes: [LIVE, FUTURE] }]

type Rec = {
  id: string
  channel_stream_id: number
  channel_name: string
  title: string
  start_utc: string
  stop_utc: string
  status: string
  file_path: string | null
  error: string | null
  created_at: string
  updated_at: string
}

function rec(id: string, title: string, status: string, over: Partial<Rec> = {}): Rec {
  return {
    id,
    channel_stream_id: 101,
    channel_name: 'US ABC',
    title,
    start_utc: '2026-10-09T20:00:00.000Z',
    stop_utc: '2026-10-09T21:00:00.000Z',
    status,
    file_path: status === 'completed' ? `/dvr/${id}.ts` : null,
    error: null,
    created_at: '2026-10-09T00:00:00Z',
    updated_at: '2026-10-09T00:00:00Z',
    ...over,
  }
}

type Handler = (url: URL, route: Route) => Promise<void> | void | false

async function setup(
  page: Page,
  opts: { dvrEnabled?: boolean; user?: MockUser; recordings?: Rec[]; dvr?: Handler; iptv?: Handler } = {},
) {
  await installBackgroundMocks(page)
  await mockMe(page, opts.user ?? ADMIN_USER)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, iptvEnabled: true, ...(opts.dvrEnabled === undefined ? {} : { dvrEnabled: opts.dvrEnabled }) })),
  )
  await page.route('**/api/policy', (route) => route.fulfill(json({ maxContentRating: null, allowedSections: null, kid: false })))
  await page.route('**/api/media/**', (route) => route.fulfill(json({ items: [], total: 0 })))

  const recordings = [...(opts.recordings ?? [])]
  const dvrCalls: string[] = []
  const schedules: unknown[] = []
  await page.route('**/api/dvr/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    dvrCalls.push(`${method} ${url.pathname}`)
    if (opts.dvr && (await opts.dvr(url, route)) !== false) return
    if (url.pathname.endsWith('/play')) {
      return route.fulfill({ status: 200, contentType: 'video/mp2t', body: readFileSync(`${FIXTURE_DIR}/seg_00000.mpegts`) })
    }
    if (url.pathname.endsWith('/grant')) {
      const id = url.pathname.split('/').at(-2)
      return route.fulfill(json({ url: `/api/dvr/recordings/${id}/play?t=tok`, delivery: 'progressive', mime: 'video/mp2t' }))
    }
    if (url.pathname.endsWith('/recordings') && method === 'POST') {
      const body = route.request().postDataJSON() as Rec
      schedules.push(body)
      const created = { ...rec(`new-${schedules.length}`, body.title, 'scheduled'), ...body }
      recordings.unshift(created)
      return route.fulfill(json({ recording: created }, 201))
    }
    if (url.pathname.endsWith('/recordings')) return route.fulfill(json({ recordings }))
    if (method === 'DELETE') {
      const id = url.pathname.split('/').pop()
      const i = recordings.findIndex((r) => r.id === id)
      if (i >= 0) recordings.splice(i, 1)
      return route.fulfill(json({ status: 'deleted' }))
    }
    return route.fulfill(json({ error: 'not_found' }, 404))
  })

  const grants: string[] = []
  const kills: string[] = []
  await page.route('**/api/iptv/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const method = route.request().method()
    if (p.endsWith('/grant')) grants.push(`${p}${url.search}`)
    if (method === 'DELETE' && p.includes('/sessions/')) kills.push(decodeURIComponent(p.split('/').pop() ?? ''))
    if (opts.iptv && (await opts.iptv(url, route)) !== false) return
    if (p.endsWith('/grant')) {
      const id = p.split('/').at(-2)
      const sid = url.searchParams.get('intent') === 'preview' ? `preview:${id}` : `live:${id}`
      return route.fulfill(json({ url: `/api/iptv/stream/live/${id}/remux/index.m3u8?t=tok`, delivery: 'hls', sessionId: sid }))
    }
    if (p.endsWith('index.m3u8')) {
      return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: readFileSync(`${FIXTURE_DIR}/index.m3u8`, 'utf-8') })
    }
    if (p.includes('seg_')) {
      return route.fulfill({ status: 200, contentType: 'video/mp2t', body: readFileSync(`${FIXTURE_DIR}/${p.split('/').pop()}`) })
    }
    if (p.endsWith('/categories')) return route.fulfill(json([{ category_id: 21, name: 'US| Sports', parent_id: 0 }]))
    if (p.endsWith('/live')) return route.fulfill(json({ items: [ABC], total: 1, limit: 100, offset: 0 }))
    if (p.endsWith('/epg/grid')) return route.fulfill(json(url.searchParams.get('q') ? [] : GRID))
    if (p.endsWith('/epg/now') || p.endsWith('/favorites')) return route.fulfill(json([]))
    if (p.endsWith('/epg/search')) return route.fulfill(json({ hits: [], total: 0 }))
    if (p.endsWith('/sessions')) return route.fulfill(json({ self: 'plex:1001', upstream: null, ours: [] }))
    if (method === 'DELETE') return route.fulfill({ status: 204, body: '' })
    return route.fulfill(json({}))
  })
  return { dvrCalls, schedules, grants, kills, recordings }
}

const futureBlock = (page: Page) => page.getByTitle(/^Evening Movie · 60 min · details$/)

test('without dvrEnabled a future programme shows its details but nothing DVR', async ({ page }) => {
  const { dvrCalls } = await setup(page)
  await page.goto('/#/live')
  await futureBlock(page).click()

  const dialog = page.getByRole('dialog', { name: 'Evening Movie' })
  await expect(dialog).toContainText('101 · US ABC')
  await expect(dialog).toContainText('A heist goes wrong.')
  await expect(dialog.getByRole('button', { name: /Record/ })).toHaveCount(0)
  await expect(dialog).not.toContainText('admin')
  await expect(page.getByRole('button', { name: 'Recordings' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  expect(dvrCalls).toEqual([])
})

test('dvrEnabled false hides Record and Recordings too', async ({ page }) => {
  const { dvrCalls } = await setup(page, { dvrEnabled: false })
  await page.goto('/#/live')
  await futureBlock(page).click()
  await expect(page.getByRole('dialog', { name: 'Evening Movie' })).toContainText('A heist goes wrong.')
  await expect(page.getByRole('button', { name: /Record/ })).toHaveCount(0)
  expect(dvrCalls).toEqual([])
})

test('an admin records a future programme once, even on a double click', async ({ page }) => {
  const { schedules } = await setup(page, {
    dvrEnabled: true,
    // A slow POST keeps the first click in flight while the second lands.
    dvr: async (url, route) => {
      if (url.pathname.endsWith('/recordings') && route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 400))
      return false
    },
  })
  await page.goto('/#/live')
  await futureBlock(page).click()
  const dialog = page.getByRole('dialog', { name: 'Evening Movie' })

  await dialog.getByRole('button', { name: 'Record Evening Movie' }).dblclick()
  await expect(dialog.getByRole('status')).toHaveText('Recording scheduled')
  await expect(dialog.getByRole('button', { name: 'Scheduled' })).toBeDisabled()
  expect(schedules).toEqual([
    { channel_stream_id: 101, channel_name: 'US ABC', title: 'Evening Movie', start_utc: FUTURE.start_utc, stop_utc: FUTURE.stop_utc },
  ])

  // Reopening finds it on the recorder's list.
  await dialog.getByRole('button', { name: 'Close' }).click()
  await futureBlock(page).click()
  await expect(page.getByRole('dialog', { name: 'Evening Movie' }).getByRole('button', { name: 'Scheduled' })).toBeDisabled()
})

test('a recorder conflict is explained, not swallowed', async ({ page }) => {
  await setup(page, {
    dvrEnabled: true,
    dvr: (url, route) =>
      url.pathname.endsWith('/recordings') && route.request().method() === 'POST'
        ? route.fulfill(json({ error: 'channel_overlap' }, 400))
        : false,
  })
  await page.goto('/#/live')
  await futureBlock(page).click()
  const dialog = page.getByRole('dialog', { name: 'Evening Movie' })
  await dialog.getByRole('button', { name: 'Record Evening Movie' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The recorder reported a scheduling conflict.')
  await expect(dialog.getByRole('button', { name: 'Record Evening Movie' })).toBeEnabled()
})

test('a member sees programme details and recordings but cannot record or delete', async ({ page }) => {
  await setup(page, { dvrEnabled: true, user: REGULAR_USER, recordings: [rec('r1', 'Old Game', 'completed')] })
  await page.goto('/#/live')
  await futureBlock(page).click()
  const dialog = page.getByRole('dialog', { name: 'Evening Movie' })
  await expect(dialog).toContainText('Only a household admin can schedule recordings.')
  await expect(dialog.getByRole('button', { name: /Record/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'Recordings' }).click()
  const panel = page.getByRole('dialog', { name: 'Recordings' })
  await panel.getByRole('button', { name: /Old Game/ }).click()
  await expect(panel.getByRole('button', { name: 'Play' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0)
})

test('recordings: list, detail, and play a completed one as a finite asset', async ({ page }) => {
  const { dvrCalls } = await setup(page, {
    dvrEnabled: true,
    recordings: [
      rec('r3', 'Late Show', 'scheduled', { start_utc: '2026-10-11T03:00:00.000Z' }),
      rec('r2', 'Big Match', 'completed'),
      rec('r1', 'Broken Feed', 'failed', { error: 'ffmpeg exited 1' }),
    ],
  })
  await page.goto('/#/live')
  await page.getByRole('button', { name: 'Recordings' }).click()
  const panel = page.getByRole('dialog', { name: 'Recordings' })

  const rows = panel.locator('.dvr-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Late Show')
  await expect(rows.nth(0)).toContainText('Scheduled')
  await expect(rows.nth(1).locator('.dvr-row__badge')).toHaveText('Ready')

  await rows.nth(2).click()
  await expect(panel.locator('dl')).toContainText('Error')
  await expect(panel.locator('dl')).toContainText('ffmpeg exited 1')
  await expect(panel.getByRole('button', { name: 'Play' })).toHaveCount(0)
  await panel.getByRole('button', { name: /All recordings/ }).click()

  await rows.nth(1).click()
  for (const label of ['Channel', 'Status', 'Starts', 'Ends']) await expect(panel.locator('dt', { hasText: label })).toBeVisible()
  await panel.getByRole('button', { name: 'Play' }).click()

  await expect(page.getByRole('dialog', { name: 'Big Match' })).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => dvrCalls).toContain('GET /api/dvr/recordings/r2/play')
  expect(dvrCalls).toContain('POST /api/dvr/recordings/r2/grant')
})

test('recordings: empty and failed lists, Retry recovers', async ({ page }) => {
  let up = false
  await setup(page, {
    dvrEnabled: true,
    dvr: (url, route) => (!up && url.pathname.endsWith('/recordings') ? route.fulfill(json({ error: 'boom' }, 502)) : false),
  })
  await page.goto('/#/live')
  await page.getByRole('button', { name: 'Recordings' }).click()
  const panel = page.getByRole('dialog', { name: 'Recordings' })
  await expect(panel.getByRole('alert')).toContainText('Couldn’t load recordings.')
  up = true
  await panel.getByRole('button', { name: 'Retry' }).click()
  await expect(panel).toContainText('No recordings yet.')
})

test('deleting a recording asks first, and a failed delete puts the row back', async ({ page }) => {
  let failDelete = true
  const { dvrCalls } = await setup(page, {
    dvrEnabled: true,
    recordings: [rec('r2', 'Big Match', 'completed'), rec('r1', 'Old Game', 'completed')],
    dvr: (url, route) =>
      failDelete && route.request().method() === 'DELETE' ? route.fulfill(json({ error: 'boom' }, 500)) : false,
  })
  await page.goto('/#/live')
  await page.getByRole('button', { name: 'Recordings' }).click()
  const panel = page.getByRole('dialog', { name: 'Recordings' })
  const confirmDialog = page.locator('dialog.confirm')

  await panel.getByRole('button', { name: /Big Match/ }).click()
  await panel.getByRole('button', { name: 'Delete' }).click()
  await expect(confirmDialog).toContainText('“Big Match” will be removed.')
  await confirmDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(confirmDialog.getByRole('alert')).toBeVisible()
  await expect(panel.getByRole('button', { name: /Big Match/ })).toBeVisible()

  failDelete = false
  await confirmDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(confirmDialog).toBeHidden()
  await expect(panel.getByRole('button', { name: /Big Match/ })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Old Game/ })).toBeVisible()
  expect(dvrCalls.filter((c) => c === 'DELETE /api/dvr/recordings/r2')).toHaveLength(2)
})

test('live preview is off by default, then previews after a rest and yields to the player', async ({ page }) => {
  const { grants, kills } = await setup(page)
  await page.goto('/#/live')
  const liveBlock = page.getByTitle(/^Morning Live · 60 min$/)

  // Off by default: resting on a live programme mints nothing.
  await liveBlock.hover()
  await page.waitForTimeout(2_000)
  expect(grants).toEqual([])

  const toggle = page.getByRole('button', { name: 'Live preview' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.getByTitle('Watch US ABC live').hover()
  await liveBlock.hover()
  await expect.poll(() => grants).toEqual(['/api/iptv/stream/live/101/grant?client=avplayer&intent=preview'])
  await expect(page.getByRole('group', { name: 'US ABC live preview' }).locator('video')).toHaveJSProperty('muted', true)

  // Opening the real player tears the preview down and releases its session.
  await liveBlock.click()
  await expect(page.getByRole('dialog', { name: 'US ABC' })).toBeVisible()
  await expect.poll(() => kills).toContain('preview:101')
  await page.waitForTimeout(2_000)
  expect(grants.filter((g) => g.includes('intent=preview'))).toHaveLength(1)
})
