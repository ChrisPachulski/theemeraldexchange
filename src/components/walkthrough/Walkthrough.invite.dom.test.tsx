// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

    // The link already carried the code: a confirmation and first-visit
    // steps replace the field.
    expect(screen.queryByRole('textbox', { name: /Invite code/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('Invite attached')).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('You’re invited')
    expect(screen.getAllByText(/Pick one way to sign in/)).toHaveLength(2)
    expect(screen.getAllByText(/WorkOS, our sign-in service/)).toHaveLength(2)
    // Both blocks' Google, Apple and email links carry the invite to the WorkOS start route.
    const links = screen.getAllByRole('link', { name: /Sign in with (Google|Apple|email)/ })
    expect(links).toHaveLength(6)
    for (const link of links) expect(link).toHaveAttribute('href', expect.stringContaining(`invite=${sentinel}`))

    // Changing the code reopens the field with the attached code in it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Use a different code' })[0])
    expect(screen.getByRole('textbox', { name: /Invite code/ })).toHaveValue(sentinel)
  })

  it('accepts a whole pasted invite link, not just the bare code', () => {
    render(<Walkthrough />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A private members’ page')
    const [input] = screen.getAllByRole('textbox', { name: /Invite code/ })
    fireEvent.change(input, { target: { value: ' https://example.test/#/invite/PASTED_CODE ' } })
    const [google] = screen.getAllByRole('link', { name: 'Sign in with Google' })
    expect(google).toHaveAttribute('href', expect.stringContaining('invite=PASTED_CODE'))
    expect(google).not.toHaveAttribute('href', expect.stringContaining('example.test'))
  })
})
