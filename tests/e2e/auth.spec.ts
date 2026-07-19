import { test, expect } from '@playwright/test'
import {
  ADMIN_USER,
  REGULAR_USER,
  installBackgroundMocks,
  mockMe,
} from './helpers/mockApi'

// Smoke layer for the /api/me probe in src/lib/auth.tsx — when the
// session cookie is present and the server returns a user, the SPA
// should mount the authed Shell instead of the Walkthrough.

test.describe('auth session', () => {
  test('user lands authenticated when /api/me returns a session', async ({ page }) => {
    await installBackgroundMocks(page)
    await mockMe(page, REGULAR_USER)

    await page.goto('/')

    // UserMenu trigger surfaces the username for the signed-in user.
    // Match by text — the menu button is the only place the literal
    // username string appears in the chrome.
    await expect(page.getByText(REGULAR_USER.username, { exact: true })).toBeVisible()

    // And the Walkthrough's sign-in CTA should NOT be present.
    await expect(
      page.getByRole('button', { name: /Sign in with Plex/i }),
    ).toHaveCount(0)
  })

  test('admin lands authenticated and sees admin chrome', async ({ page }) => {
    await installBackgroundMocks(page)
    await mockMe(page, ADMIN_USER)

    await page.goto('/')

    await expect(page.getByText(ADMIN_USER.username, { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Sign in with Plex/i }),
    ).toHaveCount(0)
  })

  test('Plex backpressure retries before committing the confirmed browser session', async ({
    page,
    context,
  }) => {
    await installBackgroundMocks(page)

    const user = {
      sub: 'plex:4200',
      username: 'Household member',
      role: 'user' as const,
      auth_mode: 'plex',
    }
    let established = false
    let checks = 0
    const checkTimes: number[] = []

    await page.route('**/api/me', (route) =>
      route.fulfill({
        status: established ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(established ? { user } : { error: 'unauthenticated' }),
      }),
    )
    await page.route('**/api/auth/plex/config', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ clientId: 'public-client-id', product: 'The Emerald Exchange' }),
      }),
    )
    await page.route('**/api/auth/plex/check', async (route) => {
      checks += 1
      checkTimes.push(Date.now())
      if (checks === 1) {
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '3', 'Access-Control-Expose-Headers': 'Retry-After' },
          contentType: 'application/json',
          body: JSON.stringify({ error: 'plex_rate_limited' }),
        })
      }
      established = true
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'authorized', user }),
      })
    })
    await context.route('https://plex.tv/api/v2/pins**', (route) =>
      route.fulfill({
        status: 201,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ id: 77, code: 'ABCD' }),
      }),
    )
    await context.route('https://app.plex.tv/auth**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Plex</title>' }),
    )

    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in with Plex' }).first().click()

    await expect(page.getByRole('button', { name: 'Waiting for Plex…' }).first()).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText(user.username, { exact: true })).toBeVisible({ timeout: 12_000 })

    expect(checks).toBe(2)
    expect(checkTimes[1] - checkTimes[0]).toBeGreaterThanOrEqual(2_800)
    await expect(page.getByRole('button', { name: /Sign in with Plex/i })).toHaveCount(0)
  })
})
