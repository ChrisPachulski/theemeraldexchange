import type { Page, Route, Request } from '@playwright/test'

// Shared API-mock plumbing for the e2e specs.
//
// The SPA fires a handful of background queries on mount that aren't
// the focus of any individual test (Plex links, limits, suggestions,
// feedback, server status). Letting those hit the dev proxy would
// leave React Query in an error state and spam console noise; we
// fulfil them with safe defaults via broad catch-all routes.
//
// Playwright runs route handlers in REVERSE registration order — the
// most recently added handler wins. Each spec calls
// `installBackgroundMocks(page)` FIRST so the broad catch-alls sit at
// the bottom of the chain, then registers its scenario-specific
// overrides afterwards.

export type Role = 'admin' | 'user'

export type MockUser = {
  sub: string
  username: string
  role: Role
}

export const ADMIN_USER: MockUser = {
  sub: 'plex:1001',
  username: 'Admin',
  role: 'admin',
}

export const REGULAR_USER: MockUser = {
  sub: 'plex:1002',
  username: 'Someone',
  role: 'user',
}

export function mockMe(page: Page, user: MockUser | null) {
  return page.route('**/api/me', (route) => {
    if (user === null) {
      return route.fulfill({ status: 401, body: '{}' })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user }),
    })
  })
}

// Empty / harmless defaults for the queries every page mounts. Specs
// that need bespoke responses for any of these endpoints add their
// own handler BEFORE calling installBackgroundMocks(), since
// page.route() matches in reverse-registration order.
export async function installBackgroundMocks(page: Page) {
  await page.route('**/api/auth/methods', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ plex: true, apple: false, google: false, passkey: true }),
    }),
  )

  await page.route('**/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ claimable: false }),
    }),
  )

  await page.route('**/api/telemetry/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false }),
    }),
  )

  // Limits — used by AddMovieModal for its size cap copy.
  await page.route('**/api/limits', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ maxMovieGb: 10, maxSeasonGb: 25 }),
    }),
  )

  // Suggestions (movies + tv). 200 with empty items keeps React
  // Query happy without rendering a trending strip.
  await page.route('**/api/suggestions/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], source: 'trending', diag: null }),
    }),
  )

  // Per-user feedback. Empty buckets so no dots render and POSTs no-op.
  await page.route('**/api/feedback*', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          movie: { liked: [], disliked: [] },
          tv: { liked: [], disliked: [] },
        }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    })
  })

  // Plex deep-link metadata. The hook fetches both endpoints and just
  // uses them for "Play in Plex" hrefs; safe to return empty.
  await page.route('**/api/plex/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    }),
  )

  // Sonarr / Radarr library + queue endpoints not otherwise mocked.
  await page.route('**/api/sonarr/api/v3/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyArrayOrQueue(route.request())),
    }),
  )
  await page.route('**/api/radarr/api/v3/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyArrayOrQueue(route.request())),
    }),
  )

  // SAB history (and any unmocked SAB call) — empty.
  await page.route('**/api/sab/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        queue: emptyQueue(),
        history: { slots: [], total_size: '0', month_size: '0', week_size: '0', day_size: '0' },
      }),
    }),
  )

  // Grab activity feed (admin downloads panel).
  await page.route('**/api/grabs/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [] }),
    }),
  )

  // Admin usage dashboard.
  await page.route('**/api/usage/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    }),
  )

  // TMDB passthrough (cast lookup, etc).
  await page.route('**/api/tmdb/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cast: [] }),
    }),
  )
}

function emptyArrayOrQueue(req: Request) {
  // Radarr/Sonarr "/queue" returns a paged object; everything else
  // returns an array. Best-effort branch on the URL path.
  const url = new URL(req.url())
  if (url.pathname.endsWith('/queue')) {
    return { page: 1, pageSize: 200, totalRecords: 0, records: [] }
  }
  return []
}

export function emptyQueue() {
  return {
    status: 'Idle',
    speedlimit: '',
    speed: '0',
    sizeleft: '0',
    size: '0',
    eta: '',
    timeleft: '0:00:00',
    paused: false,
    diskspace1: '100',
    diskspacetotal1: '1000',
    diskspace2: '100',
    diskspacetotal2: '1000',
    slots: [] as Array<Record<string, unknown>>,
  }
}

// Helper for SAB-style endpoints: the SPA hits /api/sab/api?mode=...
// for both reads and writes. Match by query string so a single
// handler can fan out by mode.
export function sabHandler(
  handlers: Record<string, (route: Route, params: URLSearchParams) => void | Promise<void>>,
) {
  return async (route: Route) => {
    const url = new URL(route.request().url())
    const mode = url.searchParams.get('mode') ?? ''
    const handler = handlers[mode]
    if (!handler) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ queue: emptyQueue() }),
      })
    }
    await handler(route, url.searchParams)
  }
}
