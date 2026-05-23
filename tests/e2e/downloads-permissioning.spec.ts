import { test, expect } from '@playwright/test'
import {
  ADMIN_USER,
  REGULAR_USER,
  installBackgroundMocks,
  mockMe,
  emptyQueue,
  sabHandler,
} from './helpers/mockApi'

// DownloadsTab puts the "active" slot in the panel header (no action
// buttons) and renders the rest via QueueRow. To exercise the action
// cluster we need at least 2 slots: a Downloading one (active) and a
// Queued one that lands in QueueRow.
function twoSlotQueue() {
  return {
    queue: {
      ...emptyQueue(),
      status: 'Downloading',
      speed: '5.5',
      sizeleft: '5.5 GB',
      size: '10 GB',
      slots: [
        {
          nzo_id: 'active-1',
          filename: 'Active.Item.mkv',
          cat: 'movies',
          status: 'Downloading',
          size: '5 GB',
          sizeleft: '2 GB',
          percentage: '60',
          timeleft: '0:05:00',
          index: 0,
        },
        {
          nzo_id: 'queued-1',
          filename: 'Queued.Item.mkv',
          cat: 'movies',
          status: 'Queued',
          size: '5 GB',
          sizeleft: '5 GB',
          percentage: '0',
          timeleft: '0:10:00',
          index: 1,
        },
      ],
    },
  }
}

const queueHistoryHandlers = {
  queue: (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(twoSlotQueue()),
    }),
  history: (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        history: {
          slots: [],
          total_size: '0',
          month_size: '0',
          week_size: '0',
          day_size: '0',
        },
      }),
    }),
} satisfies Parameters<typeof sabHandler>[0]

test.describe('downloads permissioning', () => {
  test('user role sees no admin controls on queue rows', async ({ page }) => {
    await installBackgroundMocks(page)
    await mockMe(page, REGULAR_USER)
    await page.route(/\/api\/sab\/api\?/, sabHandler(queueHistoryHandlers))

    await page.goto('/#/downloads')

    // The queued row should be present (matched by filename text).
    // DownloadsTab is lazy-loaded; first-paint after navigation can
    // wait on the dynamic-import chunk + SAB queue fetch.
    await expect(page.getByText('Queued.Item.mkv')).toBeVisible({ timeout: 15000 })

    // DownloadsTab passes onPause/onResume/onDelete only when isAdmin.
    // QueueRow hides the entire actions cluster when none are supplied,
    // so for a user the Pause/Resume/Cancel buttons should be absent.
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  })

  test('admin clicks Pause → backend receives POST /queue/:nzoId/pause', async ({ page }) => {
    await installBackgroundMocks(page)
    await mockMe(page, ADMIN_USER)
    await page.route(/\/api\/sab\/api\?/, sabHandler(queueHistoryHandlers))

    // Mutations moved to REST methods in the CSRF hardening pass:
    //   POST   /api/sab/api/queue/:nzoId/pause
    //   POST   /api/sab/api/queue/:nzoId/resume
    //   DELETE /api/sab/api/queue/:nzoId
    // The old GET ?mode=queue&name=pause surface was CSRF-able and is
    // gone. Match the new shape directly.
    const captured: { method: string | null; path: string | null } = {
      method: null,
      path: null,
    }
    await page.route('**/api/sab/api/queue/**', (route) => {
      captured.method = route.request().method()
      captured.path = new URL(route.request().url()).pathname
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: true }),
      })
    })

    await page.goto('/#/downloads')

    // DownloadsTab is lazy-loaded; first-paint after navigation can
    // wait on the dynamic-import chunk + SAB queue fetch.
    await expect(page.getByText('Queued.Item.mkv')).toBeVisible({ timeout: 15000 })
    const pauseBtn = page.getByRole('button', { name: 'Pause' })
    await expect(pauseBtn).toBeVisible()
    await pauseBtn.click()

    await expect.poll(() => captured.method, { timeout: 5000 }).toBe('POST')
    expect(captured.path).toMatch(/\/api\/sab\/api\/queue\/queued-1\/pause$/)
  })
})
