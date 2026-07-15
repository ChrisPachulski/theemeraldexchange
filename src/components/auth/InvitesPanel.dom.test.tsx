// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvitesPanel } from './InvitesPanel'

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  listMembers: vi.fn(),
  revokeInvite: vi.fn(),
  revokeMember: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  authModeFromUser: () => 'plex',
  ...mocks,
}))

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
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <InvitesPanel />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    const copy = await screen.findByRole('button', { name: 'Copy invite link' })
    fireEvent.click(copy)

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/invite/${code}`)
  })
})
