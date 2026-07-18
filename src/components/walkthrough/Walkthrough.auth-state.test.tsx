import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'

const auth = vi.hoisted(() => ({
  activeSignIn: null as
    | 'plex'
    | 'apple'
    | 'passkey-login'
    | 'passkey-register'
    | null,
  setupClaimable: false,
  signIn: vi.fn(),
  appleSignIn: vi.fn(),
  passkeyLogin: vi.fn(),
  passkeyRegister: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  inviteCodeError: () => null,
  useAuth: () => ({
    ...auth,
    signInState: auth.activeSignIn ? 'pending' : 'idle',
    signInError: null,
    discoveredServers: null,
    authMethods: { plex: true, apple: true, google: false, passkey: true },
  }),
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
    auth.setupClaimable = false
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('does not label Plex as waiting during passkey login', () => {
    auth.activeSignIn = 'passkey-login'

    const html = renderToStaticMarkup(<Walkthrough />)

    expect(count(html, '>Sign in with Plex<')).toBe(2)
    expect(html).not.toContain('Waiting for Plex…')
  })

  it('shows Plex progress in both blocks without relabeling Apple', () => {
    auth.activeSignIn = 'plex'

    const html = renderToStaticMarkup(<Walkthrough />)

    expect(count(html, '>Waiting for Plex…<')).toBe(2)
    expect(count(html, '>Sign in with Apple<')).toBe(2)
    expect(html).not.toContain('Signing in…')
  })

  it('uses claim progress only for passkey registration', () => {
    auth.setupClaimable = true
    auth.activeSignIn = 'plex'

    const plexHtml = renderToStaticMarkup(<Walkthrough />)
    expect(plexHtml).not.toContain('Claiming…')
    expect(count(plexHtml, '>Claim server &amp; create passkey<')).toBe(2)

    auth.activeSignIn = 'passkey-register'
    const registrationHtml = renderToStaticMarkup(<Walkthrough />)
    expect(count(registrationHtml, '>Claiming…<')).toBe(2)
  })
})
