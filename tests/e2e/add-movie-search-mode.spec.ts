import { test, expect } from '@playwright/test'
import {
  ADMIN_USER,
  installBackgroundMocks,
  mockMe,
} from './helpers/mockApi'

// Validates the Radarr "addOptions.searchForMovie" wire format that
// AddMovieModal constructs. The dropdown ("Start search now" vs "Just
// monitor") flips the bool; this is the contract Radarr cares about,
// so we intercept the POST and inspect the body.

const FAKE_MOVIE = {
  tmdbId: 999001,
  title: 'Test Movie',
  year: 2024,
  overview: 'A movie for the test suite.',
  studio: 'TestCo',
  status: 'released',
  runtime: 100,
  images: [],
}

async function setupRadarrMocks(page: import('@playwright/test').Page) {
  // Quality profiles + root folders feed AddMovieModal's defaults.
  await page.route('**/api/radarr/api/v3/qualityprofile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, name: 'Choose Me' }]),
    }),
  )
  await page.route('**/api/radarr/api/v3/rootfolder', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, path: '/movies', freeSpace: 5_000_000_000 }]),
    }),
  )
  // Library is empty so the lookup result renders as "not in library"
  // (DetailModal then shows the Add CTA rather than Play/Upgrade).
  await page.route('**/api/radarr/api/v3/movie', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      })
    }
    // POST is the one we want to inspect; let the spec-level handler
    // attached AFTER this one intercept it (Playwright runs handlers
    // in reverse registration order, so the per-test POST hook wins).
    return route.fallback()
  })
  // Lookup returns a single test movie so the discover grid has one
  // selectable card.
  await page.route('**/api/radarr/api/v3/movie/lookup**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([FAKE_MOVIE]),
    }),
  )
}

async function openAddMovieModal(page: import('@playwright/test').Page) {
  await page.goto('/#/movies')

  // Type into the SearchInput. Placeholder copy is the load-bearing
  // hook here ("Dune, The Substance, Past Lives") since the input
  // has no label.
  const search = page.getByPlaceholder(/Dune.*Substance.*Past Lives/)
  await expect(search).toBeVisible()
  await search.fill('Test')

  // Discover grid renders one MediaCard for FAKE_MOVIE. The card is
  // a button-role with the title as its accessible name.
  const card = page.getByRole('button', { name: /Test Movie/ })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.click()

  // DetailModal opens with the "Add to library" CTA when the item
  // is NOT in the library — we mocked /movie as [].
  const addCta = page.getByRole('button', { name: 'Add to library' })
  await expect(addCta).toBeVisible()
  await addCta.click()

  // AddMovieModal mounts a <dialog> with its own "Add to library"
  // primary button. There are briefly two buttons with that label
  // during the transition (DetailModal hasn't fully closed); wait for
  // the AddMovieModal to mount by finding its specific Search field.
  await expect(page.getByRole('combobox').filter({ hasText: /Start search now/ })).toBeVisible()
}

async function captureAddMoviePost(page: import('@playwright/test').Page) {
  const captured: { body: unknown | null } = { body: null }
  // Register AFTER the generic GET-handler above so this wins for
  // POSTs (reverse registration order).
  await page.route('**/api/radarr/api/v3/movie', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    try {
      captured.body = req.postDataJSON()
    } catch {
      captured.body = null
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ...FAKE_MOVIE,
        id: 42,
        qualityProfileId: 1,
        rootFolderPath: '/movies',
        monitored: true,
        added: new Date().toISOString(),
      }),
    })
  })
  return captured
}

test.describe('add movie search-on-add', () => {
  test.beforeEach(async ({ page }) => {
    await installBackgroundMocks(page)
    await mockMe(page, ADMIN_USER)
    await setupRadarrMocks(page)
  })

  test('"Start search now" sends addOptions.searchForMovie: true', async ({ page }) => {
    const captured = await captureAddMoviePost(page)

    await openAddMovieModal(page)

    // Default selection is "now" — confirm by reading the Search
    // select before clicking Add.
    const searchSelect = page.locator('dialog.add-series select').last()
    await expect(searchSelect).toHaveValue('now')

    await page.locator('dialog.add-series').getByRole('button', { name: 'Add to library' }).click()

    await expect.poll(() => captured.body, { timeout: 5000 }).not.toBeNull()
    expect(captured.body).toMatchObject({
      tmdbId: FAKE_MOVIE.tmdbId,
      addOptions: { searchForMovie: true },
    })
  })

  test('"Just monitor" sends addOptions.searchForMovie: false', async ({ page }) => {
    const captured = await captureAddMoviePost(page)

    await openAddMovieModal(page)

    // Flip the Search dropdown to "later" / "Just monitor".
    const searchSelect = page.locator('dialog.add-series select').last()
    await searchSelect.selectOption('later')
    await expect(searchSelect).toHaveValue('later')

    await page.locator('dialog.add-series').getByRole('button', { name: 'Add to library' }).click()

    await expect.poll(() => captured.body, { timeout: 5000 }).not.toBeNull()
    expect(captured.body).toMatchObject({
      tmdbId: FAKE_MOVIE.tmdbId,
      addOptions: { searchForMovie: false },
    })
  })
})

