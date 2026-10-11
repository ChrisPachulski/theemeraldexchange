import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextHash, parseHash, takeIntent, type Route } from './router'

// vitest runs in the `node` environment (see vitest.config.ts) where `window`
// is undefined — there is no jsdom/happy-dom renderer and no @testing-library.
// We synthesize just enough of `window.location.hash` with vi.stubGlobal and
// tear it down in afterEach so a leftover global never leaks between cases.
// Mirrors the teardown pattern in viewTransition.test.ts.

const stubHash = (h: string) => vi.stubGlobal('window', { location: { hash: h } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseHash', () => {
  const routes: Route[] = ['home', 'tv', 'movies', 'live', 'downloads', 'users', 'youtube', 'music']

  it.each(routes)('resolves canonical #/%s to itself', (route) => {
    stubHash(`#/${route}`)
    expect(parseHash()).toBe(route)
  })

  it('normalizes bare-hash and prefix variants', () => {
    stubHash('#tv')
    expect(parseHash()).toBe('tv')
    stubHash('#/tv')
    expect(parseHash()).toBe('tv')
    stubHash('tv')
    expect(parseHash()).toBe('tv')
  })

  it('is case-insensitive', () => {
    stubHash('#/TV')
    expect(parseHash()).toBe('tv')
    stubHash('#/Tv')
    expect(parseHash()).toBe('tv')
  })

  it('strips surrounding whitespace', () => {
    stubHash('#/  movies  ')
    expect(parseHash()).toBe('movies')
  })

  it('falls back to home on empty/missing hash', () => {
    stubHash('')
    expect(parseHash()).toBe('home')
    stubHash('#')
    expect(parseHash()).toBe('home')
    stubHash('#/')
    expect(parseHash()).toBe('home')
  })

  it('falls back to home on unknown/invalid values', () => {
    stubHash('#/bogus')
    expect(parseHash()).toBe('home')
    stubHash('#/settings')
    expect(parseHash()).toBe('home')
    stubHash('#/tv/extra')
    expect(parseHash()).toBe('home')
    stubHash('#/home/5')
    expect(parseHash()).toBe('home')
    stubHash('#/movies/tvdb')
    expect(parseHash()).toBe('home')
    stubHash('#/123')
    expect(parseHash()).toBe('home')
  })

  it('does not partial-match substrings or supersets of a real route', () => {
    stubHash('#/mov')
    expect(parseHash()).toBe('home')
    stubHash('#/moviesx')
    expect(parseHash()).toBe('home')
  })
})

describe('nextHash', () => {
  it('returns null for same-route navigation (no-op)', () => {
    expect(nextHash('home', 'home')).toBeNull()
    expect(nextHash('movies', 'movies')).toBeNull()
  })

  it('builds #/<next> for a route change', () => {
    expect(nextHash('home', 'tv')).toBe('#/tv')
    expect(nextHash('movies', 'live')).toBe('#/live')
    expect(nextHash('users', 'home')).toBe('#/home')
  })
})

describe('open-title intents', () => {
  const stubIntentHash = (h: string) => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', { location: { hash: h }, history: { state: null, replaceState } })
    return replaceState
  }

  it('routes #/<tab>/<ref> to the tab', () => {
    stubHash('#/movies/12')
    expect(parseHash()).toBe('movies')
    stubHash('#/tv/tvdb:81189')
    expect(parseHash()).toBe('tv')
    stubHash('#/live/200158440')
    expect(parseHash()).toBe('live')
  })

  it('takes a library id or lookup term once and clears it from the URL', () => {
    const replaceState = stubIntentHash('#/tv/tmdb:1396')
    expect(takeIntent('tv')).toBe('tmdb:1396')
    expect(replaceState).toHaveBeenCalledWith(null, '', '#/tv')

    stubIntentHash('#/movies/42')
    expect(takeIntent('movies')).toBe('42')
  })

  it("ignores another tab's intent and a bare route", () => {
    const other = stubIntentHash('#/movies/42')
    expect(takeIntent('tv')).toBeNull()
    expect(other).not.toHaveBeenCalled()
    const bare = stubIntentHash('#/movies')
    expect(takeIntent('movies')).toBeNull()
    expect(bare).not.toHaveBeenCalled()
  })
})
