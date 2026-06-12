// @vitest-environment jsdom
//
// Mounted tests for the brand mark. EmeraldMark now pulls three.js in via a
// dynamic import after mount (three is ~600KB and only the brand mark uses it,
// so it lives in its own lazy chunk). These tests pin the two invariants that
// keep that deferral safe: the <canvas> renders immediately as the pre-boot
// frame (identical to the WebGL-unavailable fallback), and unmounting before
// the gemScene chunk resolves does not throw or leak an unhandled rejection.
//
// In jsdom there is no WebGL context, so when the dynamic import resolves the
// GemScene constructor throws into the component's try/catch — the same path a
// real browser without WebGL takes — which is exactly the behavior under test.

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmeraldMark } from './EmeraldMark'

afterEach(cleanup)

describe('EmeraldMark', () => {
  it('renders the brand canvas immediately, before the gem scene chunk loads', () => {
    render(<EmeraldMark />)
    const canvas = screen.getByLabelText('The Emerald Exchange')
    expect(canvas.tagName).toBe('CANVAS')
    expect(canvas).toHaveAttribute('role', 'img')
  })

  it('does not throw or log unhandled rejections when unmounted before the import resolves', async () => {
    const rejections: unknown[] = []
    const onRejection = (e: PromiseRejectionEvent) => rejections.push(e.reason)
    window.addEventListener('unhandledrejection', onRejection)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { unmount } = render(<EmeraldMark />)
    // Tear down synchronously, before the dynamic import('./gemScene') settles.
    expect(() => unmount()).not.toThrow()

    // Let the pending import + any microtasks drain so an unhandled rejection,
    // if one existed, would surface.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.waitFor(() => {
      expect(rejections).toEqual([])
    })

    window.removeEventListener('unhandledrejection', onRejection)
    errorSpy.mockRestore()
  })
})
