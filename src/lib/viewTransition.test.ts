import { afterEach, describe, expect, it, vi } from 'vitest'
import { withViewTransition } from './viewTransition'

// These pin all four branches of withViewTransition (spec P0.3). vitest runs
// in the `node` environment (see vitest.config.ts) where `document`/`window`
// are undefined — there is no jsdom/happy-dom renderer and no @testing-library.
// We synthesize just enough of the DOM with vi.stubGlobal and tear it all down
// in afterEach so a leftover global from one case never leaks into the next.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('withViewTransition', () => {
  it('runs cb directly when document is undefined (SSR)', () => {
    vi.stubGlobal('document', undefined)
    const cb = vi.fn()

    // No document global exists, so there is nothing to call
    // startViewTransition on — the branch just must not throw.
    expect(() => withViewTransition(cb)).not.toThrow()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('runs cb directly when startViewTransition is unavailable (older Safari)', () => {
    // document exists but lacks the View Transitions API.
    vi.stubGlobal('document', {} as unknown as Document)
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false })),
    })
    const cb = vi.fn()

    withViewTransition(cb)

    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('skips startViewTransition under prefers-reduced-motion and runs cb directly', () => {
    const svt = vi.fn((fn: () => void) => fn())
    vi.stubGlobal('document', { startViewTransition: svt } as unknown as Document)
    const matchMedia = vi.fn(() => ({ matches: true }))
    vi.stubGlobal('window', { matchMedia })
    const cb = vi.fn()

    withViewTransition(cb)

    expect(svt).not.toHaveBeenCalled()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })

  it('wraps cb in startViewTransition on the happy path (API present, motion allowed)', () => {
    const svt = vi.fn((fn: () => void) => fn())
    vi.stubGlobal('document', { startViewTransition: svt } as unknown as Document)
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false })),
    })
    const cb = vi.fn()

    withViewTransition(cb)

    expect(svt).toHaveBeenCalledTimes(1)
    expect(svt).toHaveBeenCalledWith(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('treats a missing/non-function matchMedia as motion allowed (does NOT throw, wraps cb)', () => {
    const svt = vi.fn((fn: () => void) => fn())
    vi.stubGlobal('document', { startViewTransition: svt } as unknown as Document)
    // window exists but has no matchMedia → prefersReducedMotion() returns
    // false → motion-allowed branch wraps cb.
    vi.stubGlobal('window', {})
    const cb = vi.fn()

    expect(() => withViewTransition(cb)).not.toThrow()
    expect(svt).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not double-invoke cb when startViewTransition executes synchronously', () => {
    const svt = vi.fn((fn: () => void) => fn())
    vi.stubGlobal('document', { startViewTransition: svt } as unknown as Document)
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false })),
    })
    const cb = vi.fn()

    withViewTransition(cb)

    // Guards against a future refactor that both wraps AND falls through.
    expect(svt).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
