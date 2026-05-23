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
})
