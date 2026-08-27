import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'

const auth = vi.hoisted(() => ({
  activeSignIn: null as 'plex' | 'apple' | null,
  signIn: vi.fn(),
  appleSignIn: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  inviteCodeError: () => null,
  deniedMessage: () => 'denied',
  useAuth: () => ({
    ...auth,
    signInState: auth.activeSignIn ? 'pending' : 'idle',
    signInError: null,
    discoveredServers: null,
    authMethods: { plex: true, apple: true, google: false, workos: true },
  }),
}))

vi.mock('../../lib/api/base', () => ({
  apiUrl: (path: string, params?: Record<string, string>) =>
    `${path}?${new URLSearchParams(params ?? {}).toString()}`,
}))
vi.mock('../atmosphere/Kraken', () => ({ Kraken: () => null }))
vi.mock('../atmosphere/EmeraldMark', () => ({ EmeraldMark: () => null }))
vi.mock('../search/TrendingRow', () => ({ TrendingRow: () => null }))

function count(html: string, text: string): number {
  return html.split(text).length - 1
}

describe('Walkthrough provider-specific progress', () => {
  beforeEach(() => {
    auth.activeSignIn = null
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('does not label Plex as waiting during an Apple sign-in', () => {
    auth.activeSignIn = 'apple'

    const html = renderToStaticMarkup(<Walkthrough />)

    expect(count(html, '>Sign in with Plex<')).toBe(2)
    expect(html).not.toContain('Waiting for Plex…')
  })

  it('shows Plex progress in both blocks without relabeling Apple', () => {
    auth.activeSignIn = 'plex'

    const html = renderToStaticMarkup(<Walkthrough />)

    expect(count(html, '>Waiting for Plex…<')).toBe(2)
    // Native SIWA button + the WorkOS Apple link, in both blocks.
    expect(count(html, '>Sign in with Apple<')).toBe(4)
    expect(html).not.toContain('Signing in…')
  })

  it('renders the WorkOS Google and Apple links in both blocks', () => {
    const html = renderToStaticMarkup(<Walkthrough />)
    expect(count(html, '>Sign in with Google<')).toBe(2)
    expect(count(html, 'provider=google')).toBe(2)
    expect(count(html, 'provider=apple')).toBe(2)
  })
})
