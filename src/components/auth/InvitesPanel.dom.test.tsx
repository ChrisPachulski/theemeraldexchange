// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvitesPanel } from './InvitesPanel'
import { ConfirmProvider } from '../confirm/ConfirmProvider'

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  listMembers: vi.fn(),
  revokeInvite: vi.fn(),
  revokeMember: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({ ...mocks }))

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <InvitesPanel />
      </ConfirmProvider>
    </QueryClientProvider>,
  )
}

// jsdom lacks <dialog> showModal/close; the confirm modal only reads d.open.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
})

describe('InvitesPanel sharing', () => {
  const code = 'A'.repeat(22)
  const writeText = vi.fn()

  beforeEach(() => {
    mocks.listInvites.mockResolvedValue([])
    mocks.listMembers.mockResolvedValue([])
    mocks.createInvite.mockResolvedValue({
      code,
      code_hash_prefix: '12345678',
      label: 'Brother',
      expires_at: '2026-07-29T00:00:00.000Z',
      max_uses: 1,
    })
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('copies a one-click invite link instead of a bare code', async () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    const copy = await screen.findByRole('button', { name: 'Copy invite link' })
    fireEvent.click(copy)

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/invite/${code}`)
  })
})

function invite(prefix: string, status: 'active' | 'expired' | 'exhausted' | 'revoked') {
  return {
    code_hash_prefix: prefix,
    issued_by: 'workos:user_1',
    label: `${status} invite`,
    expires_at: '2026-07-29T00:00:00.000Z',
    max_uses: 1,
    used_count: status === 'exhausted' ? 1 : 0,
    created_at: '2026-07-01T00:00:00.000Z',
    revoked_at: status === 'revoked' ? '2026-07-02T00:00:00.000Z' : null,
    status,
  }
}

describe('InvitesPanel history and confirmations', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hides used/expired/revoked invites until asked, and offers Revoke only on active ones', async () => {
    mocks.listMembers.mockResolvedValue([])
    mocks.listInvites.mockResolvedValue([
      invite('aaaa', 'active'),
      invite('bbbb', 'expired'),
      invite('cccc', 'exhausted'),
      invite('dddd', 'revoked'),
    ])
    mount()

    await screen.findByText('active invite')
    expect(screen.queryByText('expired invite')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show used & expired' }))
    for (const name of ['expired invite', 'exhausted invite', 'revoked invite']) {
      const row = screen.getByText(name).closest('li')!
      expect(within(row).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
    }
    const active = screen.getByText('active invite').closest('li')!
    expect(within(active).getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('asks before revoking a member, and Keep changes nothing', async () => {
    mocks.listInvites.mockResolvedValue([])
    mocks.listMembers.mockResolvedValue([
      {
        sub: 'workos:user_7',
        display_name: 'Cousin',
        role: 'user',
        auth_mode: 'workos',
        invited_by: 'workos:user_1',
        joined_at: '2026-07-01T00:00:00.000Z',
        revoked_at: null,
        is_admin: false,
      },
    ])
    mocks.revokeMember.mockResolvedValue(undefined)
    mount()

    const row = (await screen.findByText('Cousin')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Cousin will lose access on every sign-in method.')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }))
    expect(mocks.revokeMember).not.toHaveBeenCalled()

    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await vi.waitFor(() => expect(mocks.revokeMember).toHaveBeenCalledWith('workos:user_7'))
  })
})
