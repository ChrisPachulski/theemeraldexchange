import { test, expect } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Home shelves and open-a-title links honour the member's rating cap the way
// the tabs do: above-cap titles never show, unrated picks are withheld, and a
// link to a blocked title doesn't open its detail.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const movie = (id: number, title: string, certification: string, added: string) => ({
  id, tmdbId: 1000 + id, title, year: 2020, added, certification,
  images: [], monitored: true, hasFile: true, status: 'released',
})

test('a capped member sees only allowed titles on Home and cannot open a blocked one by link', async ({ page }) => {
  await installBackgroundMocks(page)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, iptvEnabled: true, radarrEnabled: true, sonarrEnabled: false, mediaEnabled: false })),
  )
  await page.route('**/api/policy', (route) =>
    route.fulfill(json({ maxContentRating: 'PG', allowedSections: { live: false, downloads: true, arr: true }, kid: false })),
  )
  await page.route('**/api/radarr/api/v3/movie', (route) =>
    route.fulfill(json([
      movie(1, 'Family Film', 'PG', '2026-10-09T10:00:00Z'),
      movie(2, 'Adult Film', 'R', '2026-10-10T10:00:00Z'),
    ])),
  )
  await mockMe(page, REGULAR_USER)

  await page.goto('/#/home')
  const recent = page.getByRole('region', { name: 'Recently added movies' })
  await expect(recent.getByRole('button', { name: /Family Film/ })).toBeVisible()
  await expect(recent.getByText('Adult Film')).toHaveCount(0)
  await expect(page.getByRole('region', { name: /picked for you|Trending movies/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'On now' })).toHaveCount(0)

  await page.goto('/#/movies/2')
  await expect(page.getByText('That title isn’t available on this profile.')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Adult Film' })).toHaveCount(0)
})

test('a blocked title opened by link before the policy loads closes once the cap arrives', async ({ page }) => {
  await installBackgroundMocks(page)
  await page.route('**/api/limits', (route) =>
    route.fulfill(json({ maxMovieGb: 10, iptvEnabled: true, radarrEnabled: true, sonarrEnabled: false, mediaEnabled: false })),
  )
  // The library answers first; the cap lands after the link has been handled.
  await page.route('**/api/policy', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.fulfill(json({ maxContentRating: 'PG', allowedSections: { live: true, downloads: true, arr: true }, kid: true }))
  })
  await page.route('**/api/radarr/api/v3/movie', (route) =>
    route.fulfill(json([movie(2, 'Adult Film', 'R', '2026-10-10T10:00:00Z')])),
  )
  await mockMe(page, REGULAR_USER)

  const policy = page.waitForResponse('**/api/policy')
  await page.goto('/#/movies/2')
  await policy
  await expect(page.getByRole('dialog', { name: 'Adult Film' })).toHaveCount(0)
})
