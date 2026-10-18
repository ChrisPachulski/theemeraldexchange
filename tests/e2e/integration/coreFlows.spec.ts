import { test, expect } from '@playwright/test'
import { loginAsAdmin } from '../helpers/session'

// REAL client↔server integration flows (playwright project `integration`,
// PW_INTEGRATION=1). NOTHING here is route-mocked: the browser talks to
// the real Vite dev server, which proxies /api/* to the REAL Rust gateway
// (tests/e2e/helpers/integrationServer.ts) running against throwaway
// sqlite, with only the third-party upstreams (Radarr/Sonarr/SAB)
// stubbed at the HTTP boundary (tests/e2e/helpers/stubUpstreams.ts).
//
// That means these specs exercise for real: session JWE verify, the
// reconcile-per-request authz gate, the CSRF layer, the *arr allowlist
// proxies, the capped-grab pipeline, and the SPA's actual fetch layer —
// the layers the mocked tier (tests/e2e/*.spec.ts) bypasses entirely.

const STUB_BASE = 'http://127.0.0.1:3106'


test.describe('real backend integration', () => {
  test('home loads with a real session and the real suggestions fallback', async ({
    page,
    baseURL,
  }) => {
    await loginAsAdmin(page, baseURL)

    // The SPA's /api/me hits the real reconcile pipeline (session JWE
    // decrypt + ADMIN_SUBS allowlist) — a real signed-in shell must render,
    // not the logged-out walkthrough. HomeTab's section entries are the
    // logged-in marker.
    await page.goto('/')
    const sections = page.getByRole('navigation', { name: 'Sections' })
    await expect(sections.getByRole('button', { name: 'Movies' })).toBeVisible({
      timeout: 15_000,
    })
    // The admin role survived the round-trip through the gateway.
    const me = await page.request.get('/api/me')
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ user: { role: 'admin', auth_mode: 'local' } })

    // The integration env deliberately configures NO TMDB key and NO
    // local recommender, so the REAL suggestions route must degrade
    // honestly: 503 with the documented tmdb_not_configured error (the
    // SPA renders the strip-less fallback rather than crashing).
    const sugg = await page.request.get('/api/suggestions/movie')
    expect(sugg.status()).toBe(503)
    expect(await sugg.json()).toMatchObject({ error: 'tmdb_not_configured' })

    // And the shell stayed functional after that degradation: the Movies
    // tab still mounts its search UI.
    await page.goto('/#/movies')
    await expect(page.getByRole('searchbox', { name: /search movies/i })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('add-movie drives the real capped-grab pipeline against stub Radarr', async ({
    page,
    baseURL,
  }) => {
    await loginAsAdmin(page, baseURL)
    await page.goto('/#/movies')

    // Search hits the real /api/radarr/api/v3/movie/lookup proxy → stub.
    const search = page.getByRole('searchbox', { name: /search movies/i })
    await expect(search).toBeVisible({ timeout: 15_000 })
    await search.fill('Integration')

    const card = page.getByRole('button', { name: /Integration Test Movie/ })
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()

    await page.getByRole('button', { name: 'Add to library' }).click()
    // AddMovieModal (a <dialog>) mounts with its own primary button.
    const dialog = page.locator('dialog.add-series')
    await expect(dialog).toBeVisible()

    // The real POST runs the whole pipeline server-side: policy resolve,
    // disk-space gate (stub advertises 500 GB free), the add, then the
    // AWAITED capped grab (release search + grab POST) before the 201
    // reaches the SPA. The server sleeps 1.5s before the release search,
    // so allow generous time.
    const addResponse = page.waitForResponse(
      (r) => r.url().includes('/api/radarr/api/v3/movie') && r.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await dialog.getByRole('button', { name: 'Add to library' }).click()
    const res = await addResponse
    expect(res.status()).toBe(201)

    // Deep assertion via the stub's introspection endpoint: the backend
    // really issued the capped grab upstream (guid/indexer of the one
    // under-cap release), i.e. the add wasn't just persisted — the
    // download pipeline fired.
    const state = await (await page.request.get(`${STUB_BASE}/__stub/state`)).json()
    expect(state.radarrMovieAdds.length).toBeGreaterThanOrEqual(1)
    // The cap rewrite must have disabled Radarr's own search (the capped
    // grab is the only sanctioned download path).
    expect(state.radarrMovieAdds[0]).toMatchObject({
      tmdbId: 999_001,
      addOptions: { searchForMovie: false },
    })
    expect(state.radarrGrabs).toContainEqual({ guid: 'stub-release-guid-1', indexerId: 7 })

    // Modal closed on success.
    await expect(dialog).toBeHidden({ timeout: 10_000 })
  })

  test('downloads tab renders the real SAB queue through the proxy', async ({ page, baseURL }) => {
    await loginAsAdmin(page, baseURL)

    const queueResponse = page.waitForResponse(
      (r) => r.url().includes('/api/sab/api') && r.url().includes('mode=queue'),
      { timeout: 20_000 },
    )
    await page.goto('/#/downloads')
    expect((await queueResponse).status()).toBe(200)

    // The stub queue carries one in-flight item; the real backend proxy
    // (allowlist + apikey splice) forwarded it and the SPA rendered it.
    await expect(page.getByText('Integration.Test.Movie.2024.1080p.WEB-DL')).toBeVisible({
      timeout: 15_000,
    })
  })
})
