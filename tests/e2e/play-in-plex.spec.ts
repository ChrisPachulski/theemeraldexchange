import { test, expect, type Page } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe, type MockUser } from './helpers/mockApi'

// "Play in Plex" and the Watch link: a member who signed in with Plex can
// always leave for Plex itself; anyone else never sees a Plex affordance.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const MATRIX = {
  id: 7, tmdbId: 603, title: 'The Matrix', year: 1999, added: '2026-10-01T00:00:00Z', certification: 'R',
  images: [], monitored: true, hasFile: true, status: 'released',
}

async function setup(page: Page, user: MockUser) {
  await installBackgroundMocks(page)
  await mockMe(page, user)
  await page.route('**/api/radarr/api/v3/movie', (r) => r.fulfill(json([MATRIX])))
  await page.route('**/api/tmdb/**', (r) => r.fulfill(json({ cast: [], videos: [], items: [] })))
  // Registered after installBackgroundMocks, so these win over its empty /api/plex/** stub.
  await page.route('**/api/plex/library-links', (r) =>
    r.fulfill(json({
      movie: { byTmdb: { '603': '42' }, byTvdb: {}, byImdb: {} },
      tv: { byTmdb: {}, byTvdb: {}, byImdb: {} },
    })),
  )
  await page.route('**/api/plex/server-id', (r) => r.fulfill(json({ serverId: 'srv-1' })))
}

test('a Plex member gets a Play in Plex deep link and the Watch link', async ({ page }) => {
  await setup(page, REGULAR_USER)
  await page.goto('/#/movies/7')

  const play = page.getByRole('dialog', { name: 'The Matrix' }).getByRole('link', { name: 'Play in Plex ->' })
  await expect(play).toHaveAttribute(
    'href',
    'https://app.plex.tv/desktop/index.html#!/server/srv-1/details?key=%2Flibrary%2Fmetadata%2F42',
  )
  await expect(play).toHaveAttribute('target', '_blank')
  await expect(page.getByRole('link', { name: 'Open Plex in a new tab' })).toHaveAttribute(
    'href',
    'https://app.plex.tv/desktop',
  )
})

test('a member who signed in another way sees no Plex affordance', async ({ page }) => {
  const plexCalls: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/plex/')) plexCalls.push(req.url())
  })
  await setup(page, { ...REGULAR_USER, sub: 'apple:000000.member.0001' })
  await page.goto('/#/movies/7')

  await expect(page.getByRole('dialog', { name: 'The Matrix' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Play in Plex ->' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open Plex in a new tab' })).toHaveCount(0)
  expect(plexCalls).toEqual([])
})
