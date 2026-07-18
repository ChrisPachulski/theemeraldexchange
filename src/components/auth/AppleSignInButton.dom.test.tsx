// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppleSignInButton } from './AppleSignInButton'

const mocks = vi.hoisted(() => ({
  appleSignIn: vi.fn(),
  beginAppleSignIn: vi.fn(),
  cancelAppleSignIn: vi.fn(),
  runAppleSignIn: vi.fn(),
  activeSignIn: null as
    | 'plex'
    | 'apple'
    | 'passkey-login'
    | 'passkey-register'
    | null,
}))

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    appleSignIn: mocks.appleSignIn,
    beginAppleSignIn: mocks.beginAppleSignIn,
    cancelAppleSignIn: mocks.cancelAppleSignIn,
    activeSignIn: mocks.activeSignIn,
    signInState: mocks.activeSignIn ? 'pending' : 'idle',
  }),
}))

vi.mock('./appleSdk', () => ({
  isAppleSignInConfigured: () => true,
  runAppleSignIn: mocks.runAppleSignIn,
}))

describe('AppleSignInButton browser behavior', () => {
  beforeEach(() => {
    mocks.activeSignIn = null
    mocks.appleSignIn.mockResolvedValue(false)
    mocks.beginAppleSignIn.mockReturnValue(1)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps Apple copy static while Plex is active', () => {
    mocks.activeSignIn = 'plex'

    render(<AppleSignInButton />)

    const button = screen.getByRole('button', { name: 'Sign in with Apple' })
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Sign in with Apple')
    expect(button).not.toHaveTextContent('Signing in…')
  })

  it.each([
    { error: 'popup_closed_by_user' },
    { error: { message: 'user_cancelled' } },
    { message: 'user_trigger_new_signin_flow' },
  ])('treats an object-shaped Apple cancellation quietly', async (rejection) => {
    const user = userEvent.setup()
    mocks.runAppleSignIn.mockRejectedValueOnce(rejection)
    render(<AppleSignInButton />)

    await user.click(screen.getByRole('button', { name: 'Sign in with Apple' }))

    await waitFor(() => expect(mocks.runAppleSignIn).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the retry message for a genuine object-shaped Apple failure', async () => {
    const user = userEvent.setup()
    mocks.runAppleSignIn.mockRejectedValueOnce({ error: 'network_down' })
    render(<AppleSignInButton />)

    await user.click(screen.getByRole('button', { name: 'Sign in with Apple' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not start Apple sign-in. Try again.',
    )
  })
})
