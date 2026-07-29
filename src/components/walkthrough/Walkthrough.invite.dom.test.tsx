// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'

const passkeyProps = vi.hoisted(() => [] as Array<{
  inviteCode?: string
  startInRegistration?: boolean
}>)

vi.mock('../../lib/auth', () => ({
  inviteCodeError: () => null,
  useAuth: () => ({
    signIn: vi.fn(),
    activeSignIn: null,
    signInError: null,
    discoveredServers: null,
    authMethods: { plex: true, apple: false, google: false, passkey: true },
    setupClaimable: false,
  }),
}))
vi.mock('../atmosphere/Kraken', () => ({ Kraken: () => null }))
vi.mock('../atmosphere/EmeraldMark', () => ({ EmeraldMark: () => null }))
vi.mock('../search/TrendingRow', () => ({ TrendingRow: () => null }))
vi.mock('../auth/AppleSignInButton', () => ({ AppleSignInButton: () => null }))
vi.mock('../auth/PasskeyButtons', () => ({
  PasskeyButtons: (props: { inviteCode?: string; startInRegistration?: boolean }) => {
    passkeyProps.push(props)
    return <span data-invite={props.inviteCode} data-registration={props.startInRegistration} />
  },
}))

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

describe('Walkthrough invite handoff', () => {
  beforeEach(() => {
    passkeyProps.length = 0
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
    expect(passkeyProps.length).toBeGreaterThanOrEqual(2)
    expect(passkeyProps.every((props) => props.inviteCode === sentinel)).toBe(true)
    expect(passkeyProps.some((props) => props.startInRegistration === true)).toBe(true)
    expect(passkeyProps.some((props) => props.startInRegistration === false)).toBe(true)
  })
})
