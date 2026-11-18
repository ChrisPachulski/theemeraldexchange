import { test, expect, devices } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// A TV's sign-in QR opens `#/link/CODE` on a phone. The Link a device panel
// must fit the phone: an auto grid track once grew to the code field's
// intrinsic width and pushed the field and the Link button off screen.

const { defaultBrowserType: _, ...iphoneSE } = devices['iPhone SE']
test.use(iphoneSE)

test('the Link a device panel fits a phone screen, Link button included', async ({ page }) => {
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/auth/device/link/claim', (route) =>
    route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'expired' }) }),
  )
  await page.goto('/#/link/WMKS7CYZ')

  const dialog = page.getByRole('dialog', { name: /Enter the code/ })
  await expect(dialog.getByRole('button', { name: 'Link device' })).toBeVisible()
  const width = page.viewportSize()!.width
  for (const el of [
    dialog.getByRole('heading'),
    dialog.getByRole('textbox', { name: 'Device code' }),
    dialog.getByRole('button', { name: 'Cancel' }),
    dialog.getByRole('button', { name: 'Link device' }),
  ]) {
    const box = (await el.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
  }
})
