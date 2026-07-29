// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initTelemetryFromServer: vi.fn(() => new Promise<boolean>(() => {})),
  mountAnimatedFavicon: vi.fn(),
  root: null as { unmount: () => void } | null,
}))

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  return {
    ...actual,
    createRoot: (container: Element | DocumentFragment) => {
      const root = actual.createRoot(container)
      mocks.root = root
      return root
    },
  }
})
vi.mock('./lib/telemetry', () => ({
  initTelemetryFromServer: mocks.initTelemetryFromServer,
}))
vi.mock('./lib/animatedFavicon', () => ({
  mountAnimatedFavicon: mocks.mountAnimatedFavicon,
}))
vi.mock('./lib/hooks/useLimits', () => ({ useLimits: () => ({ data: {} }) }))
vi.mock('./lib/router', () => ({ useRoute: () => ['home', vi.fn()] }))
vi.mock('./lib/navTransition', () => ({
  NavTransitionProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./components/nav/HomeNav', () => ({ HomeNav: () => null }))
vi.mock('./components/nav/TopNav', () => ({ TopNav: () => null }))
vi.mock('./components/nav/ReplayButton', () => ({ ReplayButton: () => null }))
vi.mock('./components/setup/SetupChecklist', () => ({ SetupChecklist: () => null }))
vi.mock('./components/atmosphere/Kraken', () => ({ Kraken: () => null }))
vi.mock('./components/tabs/HomeTab', () => ({
  HomeTab: () => <div>Authenticated home rendered</div>,
}))

describe('SPA startup invite handling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(async () => {
    await act(async () => {
      mocks.root?.unmount()
    })
    mocks.root = null
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
    document.body.replaceChildren()
  })

  it('scrubs an authenticated invite before telemetry and renders without awaiting config', async () => {
    const sentinel = 'AUTHENTICATED_INVITE_SENTINEL'
    const authProbeHashes: string[] = []
    const state = { preserved: true }
    window.history.replaceState(
      state,
      '',
      `/library?tab=recent#/invite/${encodeURIComponent(sentinel)}`,
    )
    const preservedState = window.history.state
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const localSetItem = vi.spyOn(Storage.prototype, 'setItem')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/me')) {
        authProbeHashes.push(window.location.hash)
        return Response.json({
          user: {
            sub: 'local:test',
            username: 'Test',
            role: 'user',
            auth_mode: 'local',
          },
        })
      }
      if (url.endsWith('/api/auth/methods')) {
        return Response.json({ plex: true, apple: false, google: false, passkey: true })
      }
      if (url.endsWith('/api/setup/status')) {
        return Response.json({ claimable: false })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]

    await act(async () => {
      await import('./main')
    })

    expect(await screen.findByText('Authenticated home rendered')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/library')
    expect(window.location.search).toBe('?tab=recent')
    expect(window.location.hash).toBe('')
    expect(window.history.state).toBe(preservedState)
    expect(replaceState).toHaveBeenCalledWith(preservedState, '', '/library?tab=recent')
    expect(mocks.initTelemetryFromServer).toHaveBeenCalledOnce()
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initTelemetryFromServer.mock.invocationCallOrder[0],
    )
    expect(authProbeHashes.length).toBeGreaterThan(0)
    expect(authProbeHashes).toEqual(authProbeHashes.map(() => ''))
    expect(mocks.mountAnimatedFavicon).toHaveBeenCalledOnce()
    expect(localSetItem).not.toHaveBeenCalled()
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(sentinel)
    }
  })
})
