import { describe, it, expect } from 'vitest'
import { DEFAULT_DEBOUNCE_MS, normalizeDelay } from './useDebounced'

// vitest runs in the `node` environment (no jsdom, no @testing-library,
// no react-test-renderer). We can't render useDebounced or advance its
// setTimeout effect, so we pin the extracted PURE delay-normalization
// the effect delegates to. This documents the hardening: bad input
// (NaN / negative / Infinity) falls back to the default rather than
// producing a broken setTimeout.

describe('DEFAULT_DEBOUNCE_MS', () => {
  it('is 300ms', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(300)
  })
})

describe('normalizeDelay', () => {
  it('falls back to the default when delay is undefined', () => {
    expect(normalizeDelay(undefined)).toBe(300)
  })

  it('preserves 0 — zero is a valid intentional delay, must NOT fall back', () => {
    expect(normalizeDelay(0)).toBe(0)
  })

  it('passes through a finite positive delay unchanged', () => {
    expect(normalizeDelay(150)).toBe(150)
  })

  it('falls back to the default for NaN', () => {
    expect(normalizeDelay(NaN)).toBe(300)
  })

  it('falls back to the default for a negative delay', () => {
    expect(normalizeDelay(-5)).toBe(300)
  })

  it('falls back to the default for Infinity', () => {
    expect(normalizeDelay(Infinity)).toBe(300)
  })
})
