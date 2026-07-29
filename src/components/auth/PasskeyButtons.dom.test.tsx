// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasskeyButtons } from './PasskeyButtons'

const mocks = vi.hoisted(() => ({
  passkeyLogin: vi.fn(),
  passkeyRegister: vi.fn(),
  activeSignIn: null as
    | 'plex'
    | 'apple'
    | 'passkey-login'
    | 'passkey-register'
    | null,
}))

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    ...mocks,
    signInState: mocks.activeSignIn ? 'pending' : 'idle',
  }),
}))

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
}))

describe('PasskeyButtons registration', () => {
  beforeEach(() => {
    mocks.passkeyLogin.mockResolvedValue(false)
    mocks.passkeyRegister.mockResolvedValue(false)
    mocks.activeSignIn = null
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens and focuses registration when an invite link requests setup', async () => {
    render(<PasskeyButtons inviteCode={'A'.repeat(22)} startInRegistration />)

    expect(await screen.findByRole('textbox', { name: 'Your name' })).toHaveFocus()
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

  it('keeps passkey copy static while Apple is active', async () => {
    mocks.activeSignIn = 'apple'

    render(<PasskeyButtons startInRegistration />)

    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create passkey' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Waiting…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Creating…' })).not.toBeInTheDocument()
  })

  it('shows progress only on the active passkey operation', async () => {
    mocks.activeSignIn = 'passkey-login'
    const view = render(<PasskeyButtons />)

    expect(await screen.findByRole('button', { name: 'Waiting…' })).toBeDisabled()
    view.unmount()

    mocks.activeSignIn = 'passkey-register'
    render(<PasskeyButtons startInRegistration />)

    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
  })

  it('gives two registration forms unique label/input ids', async () => {
    render(
      <>
        <PasskeyButtons startInRegistration />
        <PasskeyButtons startInRegistration />
      </>,
    )

    const inputs = await screen.findAllByRole('textbox', { name: 'Your name' })
    const labels = screen.getAllByText('Your name')
    expect(inputs).toHaveLength(2)
    expect(inputs[0].id).not.toBe(inputs[1].id)
    expect(labels.map((label) => label.getAttribute('for'))).toEqual(
      inputs.map((input) => input.id),
    )
  })
})
