// @vitest-environment jsdom
//
// Mounted tests for the UserMenu dropdown, pinning the recorded
// PRODUCT.md exception (re-review fix3, orchestrator decision): the
// Admin apps section (Sonarr/Radarr/SAB operator links) renders for
// admins ONLY — never for regular members, and not while an admin
// previews the app as a user. The heavy panels (Discord, AI key,
// devices, invites) are stubbed; their behavior has its own suites.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserMenu } from './UserMenu'

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }))

vi.mock('../../lib/auth', () => ({ useAuth: useAuthMock }))
vi.mock('./DiscordNotifications', () => ({ DiscordNotifications: () => null }))
vi.mock('./ApiKeySettings', () => ({ ApiKeySettings: () => null }))
vi.mock('./DevicesPanel', () => ({ DevicesPanel: () => null }))
vi.mock('./InvitesPanel', () => ({ InvitesPanel: () => null }))

type AuthShape = {
  user: { sub: string; username: string } | null
  role: 'admin' | 'user' | null
  effectiveRole: 'admin' | 'user' | null
  isAdmin: boolean
  setViewAs: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
  signOutError: string | null
}

function auth(over: Partial<AuthShape>): AuthShape {
  return {
    user: { sub: 'plex:1', username: 'guest' },
    role: 'user',
    effectiveRole: 'user',
    isAdmin: false,
    setViewAs: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    signOutError: null,
    ...over,
  }
}

function openMenu() {
  render(<UserMenu />)
  fireEvent.click(screen.getByRole('button', { name: /guest/i }))
}

beforeEach(() => {
  useAuthMock.mockReturnValue(auth({}))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UserMenu — Admin apps gating (operator links)', () => {
  it('renders Sonarr/Radarr/SAB links for an admin', () => {
    useAuthMock.mockReturnValue(auth({ role: 'admin', effectiveRole: 'admin', isAdmin: true }))
    openMenu()
    expect(screen.getByText('Admin apps')).toBeInTheDocument()
    for (const name of ['Sonarr', 'Radarr', 'SAB']) {
      expect(screen.getByText(name).closest('a')).toHaveAttribute(
        'href',
        expect.stringContaining(name.toLowerCase()),
      )
    }
  })

  it('never renders the operator links for a non-admin member', () => {
    useAuthMock.mockReturnValue(auth({ role: 'user', effectiveRole: 'user', isAdmin: false }))
    openMenu()
    expect(screen.queryByText('Admin apps')).not.toBeInTheDocument()
    expect(screen.queryByText('Sonarr')).not.toBeInTheDocument()
    expect(screen.queryByText('Radarr')).not.toBeInTheDocument()
    expect(screen.queryByText('SAB')).not.toBeInTheDocument()
  })

  it('hides the links while an admin previews as a user (effectiveRole gate)', () => {
    useAuthMock.mockReturnValue(auth({ role: 'admin', effectiveRole: 'user', isAdmin: false }))
    openMenu()
    // The preview toggle is still offered (role-based)…
    expect(screen.getByText('View as user')).toBeInTheDocument()
    // …but the operator links follow the previewed role.
    expect(screen.queryByText('Admin apps')).not.toBeInTheDocument()
  })
})
