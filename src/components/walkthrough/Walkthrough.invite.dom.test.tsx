// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const sentinelInvite = 'B'.repeat(22)

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
    expect(screen.queryByText(/WorkOS/)).not.toBeInTheDocument()
    // Both blocks' Google and Apple links carry the invite to the start route.
    const links = screen.getAllByRole('link', { name: /Sign in with (Google|Apple)/ })
    expect(links).toHaveLength(4)
    for (const link of links) expect(link).toHaveAttribute('href', expect.stringContaining(`invite=${sentinel}`))

    // Changing the code reopens the field with the attached code in it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Use a different code' })[0])
    expect(screen.getByRole('textbox', { name: /Invite code/ })).toHaveValue(sentinel)
  })

  it('signs in by emailed code on this page, carrying the invite', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      void url
      return new Response(JSON.stringify(url.includes('/verify') ? { user: {} } : { ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    render(<Walkthrough initialInviteCode={sentinelInvite} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in with email' })[0])
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: ' ana@example.test ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    const codeBox = await screen.findByPlaceholderText('6-digit code')
    expect(screen.getByText('ana@example.test')).toBeInTheDocument()
    fireEvent.change(codeBox, { target: { value: '12 34-56' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))

    const [startUrl, startInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(startUrl).toContain('/api/auth/workos/email/start')
    expect(JSON.parse(startInit.body as string)).toEqual({ email: 'ana@example.test' })
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(verifyUrl).toContain('/api/auth/workos/email/verify')
    expect(verifyInit.credentials).toBe('include')
    expect(JSON.parse(verifyInit.body as string)).toEqual({
      email: 'ana@example.test',
      code: '123456',
      inviteCode: sentinelInvite,
    })
  })

  it('shows why a code or invite was refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/verify')
          ? new Response(JSON.stringify({ status: 'denied', reason: 'invite_expired' }), { status: 403 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    )
    render(<Walkthrough initialInviteCode={sentinelInvite} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in with email' })[0])
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'ana@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    fireEvent.change(await screen.findByPlaceholderText('6-digit code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('denied')
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
