import { describe, it, expect } from 'vitest'
import { computeDocumentVisible } from './useVisibility'

// vitest runs in the `node` environment (no jsdom, no @testing-library,
// no react-test-renderer). We therefore can't render useDocumentVisible
// or exercise its visibilitychange effect. Instead we pin the extracted
// PURE doc→boolean mapping that both the initializer and the listener
// delegate to. If this mapping is correct, the hook is correct by
// construction; the only untested part is the (un-renderable) event
// wiring.

describe('computeDocumentVisible', () => {
  it('returns true when doc is undefined (SSR / first paint)', () => {
    expect(computeDocumentVisible(undefined)).toBe(true)
  })

  it("returns true when visibilityState === 'visible'", () => {
    expect(computeDocumentVisible({ visibilityState: 'visible' })).toBe(true)
  })

  it("returns false for 'hidden'", () => {
    expect(computeDocumentVisible({ visibilityState: 'hidden' })).toBe(false)
  })

  it("returns false for any non-'visible' value (e.g. 'prerender')", () => {
    expect(
      computeDocumentVisible({ visibilityState: 'prerender' as DocumentVisibilityState }),
    ).toBe(false)
  })

  it('is a pure function of its input only (same stub → same result)', () => {
    const stub: { visibilityState: DocumentVisibilityState } = { visibilityState: 'visible' }
    expect(computeDocumentVisible(stub)).toBe(true)
    expect(computeDocumentVisible(stub)).toBe(true)
    // Mutating the stub flips the result, proving the listener mapping
    // reads the live value and nothing is cached.
    stub.visibilityState = 'hidden'
    expect(computeDocumentVisible(stub)).toBe(false)
  })
})
