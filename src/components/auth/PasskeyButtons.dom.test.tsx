// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasskeyButtons } from './PasskeyButtons'

const mocks = vi.hoisted(() => ({
  passkeyLogin: vi.fn(),
  passkeyRegister: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    ...mocks,
    signInState: 'idle',
  }),
}))

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
}))

describe('PasskeyButtons registration', () => {
  beforeEach(() => {
    mocks.passkeyLogin.mockResolvedValue(false)
    mocks.passkeyRegister.mockResolvedValue(false)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('submits passkey registration when Enter is pressed in the name field', async () => {
    const user = userEvent.setup()
    const inviteCode = 'A'.repeat(22)
    render(<PasskeyButtons inviteCode={inviteCode} />)

    await user.click(
      await screen.findByRole('button', { name: 'First time with a passkey? Set one up' }),
    )
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Nick{Enter}')

    expect(mocks.passkeyRegister).toHaveBeenCalledOnce()
    expect(mocks.passkeyRegister).toHaveBeenCalledWith({ handle: 'Nick', inviteCode })
  })
})
