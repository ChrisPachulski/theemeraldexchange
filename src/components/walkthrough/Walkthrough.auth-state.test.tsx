import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'

const auth = vi.hoisted(() => ({
  activeSignIn: null as 'apple' | null,
  appleSignIn: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  inviteCodeError: () => null,
  deniedMessage: () => 'denied',
  useAuth: () => ({
    ...auth,
    signInState: auth.activeSignIn ? 'pending' : 'idle',
    signInError: null,
    authMethods: { apple: true, google: false, workos: true },
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

  it('offers no Plex sign-in', () => {
    const html = renderToStaticMarkup(<Walkthrough />)

    expect(html).not.toMatch(/plex/i)
    // Native SIWA button + the WorkOS Apple link, in both blocks.
    expect(count(html, '>Sign in with Apple<')).toBe(4)
  })

  it('renders the WorkOS Google, Apple and email links in both blocks', () => {
    const html = renderToStaticMarkup(<Walkthrough />)
    expect(count(html, '>Sign in with Google<')).toBe(2)
    expect(count(html, 'provider=google')).toBe(2)
    expect(count(html, 'provider=apple')).toBe(2)
    // Email goes to the hosted page: the start route with no provider at all.
    expect(count(html, '>Sign in with email<')).toBe(2)
    expect(count(html, '/api/auth/workos/start?"')).toBe(2)
  })
})
