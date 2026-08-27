// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'

vi.mock('../../lib/auth', () => ({
  inviteCodeError: () => null,
  deniedMessage: () => 'denied',
  useAuth: () => ({
    signIn: vi.fn(),
    activeSignIn: null,
    signInError: null,
    discoveredServers: null,
    authMethods: { plex: true, apple: false, google: false, workos: true },
  }),
}))
vi.mock('../atmosphere/Kraken', () => ({ Kraken: () => null }))
vi.mock('../atmosphere/EmeraldMark', () => ({ EmeraldMark: () => null }))
vi.mock('../search/TrendingRow', () => ({ TrendingRow: () => null }))
vi.mock('../auth/AppleSignInButton', () => ({ AppleSignInButton: () => null }))

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

describe('Walkthrough invite handoff', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('retains the ephemeral invite in both sign-in blocks through StrictMode replay', () => {
    const sentinel = 'STRICT_MODE_INVITE_SENTINEL'

    render(
      <StrictMode>
        <Walkthrough initialInviteCode={sentinel} />
      </StrictMode>,
    )

    const inviteInputs = screen.getAllByRole('textbox', { name: /Invite code/ })
    expect(inviteInputs).toHaveLength(2)
    for (const input of inviteInputs) expect(input).toHaveValue(sentinel)
    // Both blocks' Google + Apple links carry the invite to the WorkOS start route.
    const links = screen.getAllByRole('link', { name: /Sign in with (Google|Apple)/ })
    expect(links).toHaveLength(4)
    for (const link of links) expect(link).toHaveAttribute('href', expect.stringContaining(`invite=${sentinel}`))
  })
})
