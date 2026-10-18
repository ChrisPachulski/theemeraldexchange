import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER, installBackgroundMocks, mockMe, type MockUser } from './helpers/mockApi'

// Per-member restrictions (GET /api/policy) hide what the server would 403
// and filter browse by the rating cap; admins edit them under Invites &
// members. The server stays the authority; these pin the client mirror.

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const LIMITS = { maxMovieGb: 10, iptvEnabled: true, sabEnabled: true, sonarrEnabled: true, radarrEnabled: true }

const OPEN = { maxContentRating: null, allowedSections: null, kid: false }
const RESTRICTED = {
  maxContentRating: 'PG-13',
  allowedSections: { live: false, downloads: false, arr: false },
  kid: false,
}

const lookupHit = (tmdbId: number, title: string, certification?: string) => ({
  tmdbId,
  title,
  year: 2020,
  status: 'released',
  images: [],
  ...(certification ? { certification } : {}),
})
const movie = (id: number, title: string, certification?: string) => ({
  id,
  hasFile: true,
  ...lookupHit(id, title, certification),
})

async function setup(page: Page, user: MockUser, policy: unknown) {
  await installBackgroundMocks(page)
  await page.route('**/api/limits', (route) => route.fulfill(json(LIMITS)))
  await page.route('**/api/policy', (route) => route.fulfill(json(policy)))
  await page.route('**/api/radarr/api/v3/movie', (route) =>
    route.fulfill(json([movie(1, 'Family Film', 'PG'), movie(2, 'Adult Film', 'R'), movie(3, 'Mystery Film')])),
  )
  await page.route('**/api/radarr/api/v3/movie/lookup**', (route) =>
    route.fulfill(json([lookupHit(11, 'Search Kid', 'G'), lookupHit(12, 'Search Adult', 'NC-17')])),
  )
  await mockMe(page, user)
}

test('a restricted member loses denied sections and their routes', async ({ page }) => {
  await setup(page, REGULAR_USER, RESTRICTED)

  await page.goto('/#/')
  const sections = page.getByRole('navigation', { name: 'Sections' })
  await expect(sections.getByRole('button', { name: 'Movies' })).toBeVisible()
  await expect(sections.getByRole('button', { name: 'Live' })).toHaveCount(0)
  await expect(sections.getByRole('button', { name: 'Downloader' })).toHaveCount(0)

  await page.goto('/#/live')
  await expect(page).toHaveURL(/#\/home$/)

  await page.goto('/#/movies')
  await expect(page.getByRole('searchbox', { name: /search movies/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: 'TV Shows' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Live' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Downloads' })).toHaveCount(0)
})

test('a rating cap filters search and library, withholds the strip, and arr deny drops Add', async ({ page }) => {
  await setup(page, REGULAR_USER, RESTRICTED)

  await page.goto('/#/movies')
  const search = page.getByRole('searchbox', { name: /search movies/i })
  await expect(search).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('section.trending')).toHaveCount(0)

  await search.fill('Search')
  await expect(page.getByRole('button', { name: /Search Kid/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Search Adult/ })).toHaveCount(0)

  await page.getByRole('button', { name: /Search Kid/ }).click()
  await expect(page.getByRole('dialog', { name: /Search Kid/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add to library' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await search.fill('')
  await page.getByRole('tab', { name: /In library/ }).click()
  await expect(page.getByRole('button', { name: /Family Film/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Adult Film/ })).toHaveCount(0)
  // Unrated fails closed under a cap.
  await expect(page.getByRole('button', { name: /Mystery Film/ })).toHaveCount(0)
})

test('an open member keeps every title, the strip, and Add', async ({ page }) => {
  await setup(page, REGULAR_USER, OPEN)

  await page.goto('/#/movies')
  const search = page.getByRole('searchbox', { name: /search movies/i })
  await expect(search).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('section.trending')).toHaveCount(1)

  await search.fill('Search')
  await expect(page.getByRole('button', { name: /Search Adult/ })).toBeVisible()
  await page.getByRole('button', { name: /Search Kid/ }).click()
  await expect(page.getByRole('button', { name: 'Add to library' })).toBeVisible()
  await page.keyboard.press('Escape')

  await search.fill('')
  await page.getByRole('tab', { name: /In library/ }).click()
  await expect(page.getByRole('button', { name: /Mystery Film/ })).toBeVisible()
})

test('Users shows only for a Plex-backed admin session', async ({ page }) => {
  await setup(page, { ...ADMIN_USER, sub: 'apple:owner' }, OPEN)

  await page.goto('/#/')
  const sections = page.getByRole('navigation', { name: 'Sections' })
  await expect(sections.getByRole('button', { name: 'Movies' })).toBeVisible()
  await expect(sections.getByRole('button', { name: 'Users' })).toHaveCount(0)

  await page.goto('/#/users')
  await expect(page).toHaveURL(/#\/home$/)
})

test('a Plex admin without a Plex token is pointed at Invites & members', async ({ page }) => {
  await setup(page, ADMIN_USER, OPEN)
  await page.route('**/api/users', (route) =>
    route.fulfill(json({ error: 'no_plex_token', message: 'Re-authenticate.' }, 409)),
  )

  await page.goto('/#/')
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Users' })).toBeVisible()

  await page.goto('/#/users')
  await expect(page.getByText('Not available on this sign-in.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Manage members from Invites & members/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Sign out/ })).toHaveCount(0)
})

test('the Restrictions editor never offers Save after a failed read, then saves a full policy', async ({ page }) => {
  await setup(page, ADMIN_USER, OPEN)
  const member = {
    sub: 'plex:2002',
    display_name: 'Alice',
    role: 'user',
    auth_mode: 'plex',
    invited_by: 'plex:1001',
    joined_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    is_admin: false,
  }
  await page.route('**/api/admin/invites', (route) => route.fulfill(json({ invites: [] })))
  await page.route('**/api/admin/members', (route) => route.fulfill(json({ members: [member] })))
  let readOk = false
  await page.route('**/api/users/policies', (route) =>
    readOk
      ? route.fulfill(json({ policies: { 'plex:2002': { maxContentRating: 'R', allowedSections: null, kid: false } } }))
      : route.fulfill(json({ error: 'boom' }, 500)),
  )
  let saved: unknown = null
  await page.route(/\/api\/users\/plex%3A2002\/policy$/, (route) => {
    saved = route.request().postDataJSON()
    return route.fulfill(json(saved))
  })

  await page.goto('/#/')
  await page.getByRole('button', { name: ADMIN_USER.username, exact: true }).click()
  await page.getByText('Invites & members').click()
  await page.getByRole('button', { name: 'Restrictions', exact: true }).click()

  const editor = page.getByRole('group', { name: 'Restrictions for Alice' })
  await expect(editor.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 10_000 })
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0)

  readOk = true
  await editor.getByRole('button', { name: 'Retry' }).click()
  await expect(editor.getByRole('button', { name: 'R', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await editor.getByRole('button', { name: 'PG', exact: true }).click()
  await editor.getByRole('checkbox', { name: 'Live TV' }).uncheck()
  await editor.getByRole('checkbox', { name: 'Kid profile' }).check()
  await editor.getByRole('button', { name: 'Save' }).click()

  await expect(editor).toHaveCount(0)
  expect(saved).toEqual({
    maxContentRating: 'PG',
    allowedSections: { live: false, downloads: true, arr: true },
    kid: true,
  })
})
