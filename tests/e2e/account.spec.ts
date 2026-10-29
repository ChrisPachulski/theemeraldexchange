import { test, expect, type Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER, installBackgroundMocks, mockMe, type MockUser } from './helpers/mockApi'

// Account self-service and admin access safety, matching the Apple app:
// email sign-in, Delete account, confirmations before revoking access,
// invite history, the sign-in provider line, and the Preferences toggles.

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

async function signedIn(page: Page, user: MockUser, limits: Record<string, unknown> = {}) {
  await installBackgroundMocks(page)
  await page.route('**/api/limits', (route) => route.fulfill(json({ maxMovieGb: 10, ...limits })))
  await mockMe(page, user)
}

async function openMenu(page: Page, user: MockUser) {
  await page.goto('/')
  await page.getByRole('button', { name: new RegExp(user.username) }).click()
}

test('the sign-in block offers email through the WorkOS hosted page, invite included', async ({ page }) => {
  await installBackgroundMocks(page)
  await page.route('**/api/auth/methods', (route) =>
    route.fulfill(json({ plex: true, apple: false, google: false, workos: true })),
  )
  await mockMe(page, null)
  await page.goto('/')

  const invite = 'A'.repeat(22)
  await page.getByRole('textbox', { name: /Invite code/ }).first().fill(invite)
  const href = await page.getByRole('link', { name: 'Sign in with email' }).first().getAttribute('href')
  const url = new URL(href!)
  expect(url.pathname).toBe('/api/auth/workos/start')
  expect(url.searchParams.has('provider')).toBe(false)
  expect(url.searchParams.get('invite')).toBe(invite)
})

test('the menu names the sign-in provider', async ({ page }) => {
  await signedIn(page, REGULAR_USER)
  await openMenu(page, REGULAR_USER)
  await expect(page.getByText('Signed in with Plex as')).toBeVisible()
})

test('revoking a device and signing out everywhere both ask first', async ({ page }) => {
  await signedIn(page, REGULAR_USER)
  const deletes: string[] = []
  await page.route('**/api/devices/self**', (route) => {
    const req = route.request()
    if (req.method() === 'DELETE') {
      deletes.push(new URL(req.url()).pathname)
      return route.fulfill(json({ ok: true, revoked_count: 1 }))
    }
    return route.fulfill(json({
      devices: [{
        jti: 'jti-1', device_id: 'd1', device_name: 'Living Room', platform: 'tvos', server_id: 's',
        issued_at: '2026-10-01T00:00:00Z', expires_at: '2027-10-01T00:00:00Z',
        last_seen_at: null, last_seen_version: null, revoked: false,
      }],
    }))
  })
  await openMenu(page, REGULAR_USER)
  // exact: the closed disclosure's status line reads "No paired devices" until the list loads.
  await page.getByText('Paired devices', { exact: true }).click()

  // Scoped to the menu: the closing dialog keeps its own Revoke in the DOM.
  const menu = page.getByRole('menu')
  await menu.getByRole('button', { name: 'Revoke' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('“Living Room” will be signed out.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep' }).click()
  // The menu stays open behind the dialog, and nothing was revoked.
  await expect(menu.getByRole('button', { name: 'Sign out everywhere' })).toBeVisible()
  expect(deletes).toEqual([])

  await menu.getByRole('button', { name: 'Revoke' }).click()
  await dialog.getByRole('button', { name: 'Revoke' }).click()
  await expect.poll(() => deletes).toEqual(['/api/devices/self/jti-1'])

  await menu.getByRole('button', { name: 'Sign out everywhere' }).click()
  await expect(dialog.getByText('Every paired device will need to pair again.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Sign out all' }).click()
  await expect.poll(() => deletes).toEqual(['/api/devices/self/jti-1', '/api/devices/self'])
})

test('admins see invite history on request and confirm before revoking a member', async ({ page }) => {
  await signedIn(page, ADMIN_USER)
  const invite = (prefix: string, status: string) => ({
    code_hash_prefix: prefix, issued_by: ADMIN_USER.sub, label: `${status} invite`,
    expires_at: '2026-12-01T00:00:00Z', max_uses: 1, used_count: status === 'exhausted' ? 1 : 0,
    created_at: '2026-10-01T00:00:00Z', revoked_at: null, status,
  })
  const memberDeletes: string[] = []
  await page.route('**/api/admin/invites', (route) =>
    route.fulfill(json({ invites: [invite('aaaa', 'active'), invite('bbbb', 'exhausted')] })),
  )
  await page.route('**/api/admin/members**', (route) => {
    if (route.request().method() === 'DELETE') {
      memberDeletes.push(decodeURIComponent(new URL(route.request().url()).pathname))
      return route.fulfill(json({ ok: true }))
    }
    return route.fulfill(json({
      members: [{
        sub: 'plex:7', display_name: 'Cousin', role: 'user', auth_mode: 'plex', invited_by: ADMIN_USER.sub,
        joined_at: '2026-10-01T00:00:00Z', revoked_at: null, is_admin: false,
      }],
    }))
  })
  await openMenu(page, ADMIN_USER)
  await page.getByText('Invites & members').click()

  await expect(page.getByText('active invite')).toBeVisible()
  await expect(page.getByText('exhausted invite')).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Show used & expired' }).check()
  const usedRow = page.getByRole('listitem').filter({ hasText: 'exhausted invite' })
  await expect(usedRow).toBeVisible()
  await expect(usedRow.getByRole('button', { name: 'Revoke' })).toHaveCount(0)

  await page.getByRole('listitem').filter({ hasText: 'Cousin' }).getByRole('button', { name: 'Revoke' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Cousin will lose access on every sign-in method.')).toBeVisible()
  expect(memberDeletes).toEqual([])
  await dialog.getByRole('button', { name: 'Revoke' }).click()
  await expect.poll(() => memberDeletes).toEqual(['/api/admin/members/plex:7'])
})

test('Delete account removes the account, clears local data and signs out', async ({ page }) => {
  await signedIn(page, REGULAR_USER, { accountDeletionEnabled: true })
  let deleted = false
  await page.route('**/api/me', (route) =>
    deleted ? route.fulfill(json({}, 401)) : route.fulfill(json({ user: REGULAR_USER })),
  )
  await page.route('**/api/account/self', (route) => {
    expect(route.request().method()).toBe('DELETE')
    deleted = true
    return route.fulfill({ status: 204, body: '' })
  })
  await page.route('**/api/auth/logout', (route) => route.fulfill(json({ ok: true })))
  await openMenu(page, REGULAR_USER)
  await page.evaluate(() => {
    localStorage.setItem('eex.suggestionMode', 'trending')
    localStorage.setItem('guide.categoryIds', '1,2')
  })

  await page.getByRole('button', { name: 'Delete account' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click()

  await expect(page.getByRole('button', { name: 'Sign in with Plex' }).first()).toBeVisible()
  expect(deleted).toBe(true)
  expect(await page.evaluate(() => [localStorage.getItem('eex.suggestionMode'), localStorage.getItem('guide.categoryIds')]))
    .toEqual([null, null])
})

test('Delete account explains a last-admin refusal and changes nothing', async ({ page }) => {
  await signedIn(page, ADMIN_USER, { accountDeletionEnabled: true })
  await page.route('**/api/account/self', (route) => route.fulfill(json({ error: 'last_admin' }, 409)))
  await openMenu(page, ADMIN_USER)

  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(dialog.getByText(/you are its last administrator/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep account' }).click()
  // Still signed in, menu still open.
  await expect(page.getByRole('menu').getByRole('button', { name: 'Delete account' })).toBeVisible()
})

test('Preferences: Reduce motion survives a reload and crash reports can be switched off', async ({ page }) => {
  await signedIn(page, REGULAR_USER)
  await openMenu(page, REGULAR_USER)
  await page.getByText('Preferences').click()

  const reduce = page.getByRole('switch', { name: 'Reduce motion' })
  await expect(reduce).toHaveAttribute('aria-checked', 'false')
  await reduce.click()
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '')

  const crash = page.getByRole('switch', { name: 'Send crash reports to my server' })
  await expect(crash).toHaveAttribute('aria-checked', 'true')
  await crash.click()
  await expect(crash).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => localStorage.getItem('eex.crashReportsOff'))).toBe('1')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '')
})

test('the admin menu fits a phone: one-line card headings, and it covers the Replay pill', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signedIn(page, ADMIN_USER)
  await page.route('**/api/admin/invites', (route) => route.fulfill(json({ invites: [] })))
  await page.route('**/api/admin/members**', (route) => route.fulfill(json({ members: [] })))
  await page.goto('/')
  // The username is only visually hidden on phones; it stays the trigger's name.
  await page.getByRole('button', { name: ADMIN_USER.username, exact: true }).click()
  await page.getByText('Invites & members', { exact: true }).click()

  for (const summary of await page.locator('.user-menu__disclosure-summary').all()) {
    const box = (await summary.boundingBox())!
    expect(box.height, await summary.innerText()).toBeLessThan(48)
  }
  const onTop = await page.evaluate(() => {
    const r = document.querySelector('.replay-btn')!.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!hit?.closest('.user-menu__dropdown')
  })
  expect(onTop).toBe(true)
})
