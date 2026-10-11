// @vitest-environment jsdom
//
// Mounted tests for the UserMenu dropdown, pinning the recorded
// PRODUCT.md exception (re-review fix3, orchestrator decision): the
// Admin apps section (Sonarr/Radarr/SAB operator links) renders for
// admins ONLY — never for regular members, and not while an admin
// previews the app as a user. The heavy panels (Discord, AI key,
// devices, invites) are stubbed; their behavior has its own suites.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserMenu } from './UserMenu'
import { ConfirmProvider } from '../confirm/ConfirmProvider'
import type { Limits } from '../../lib/hooks/useLimits'

const { useAuthMock, limits } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  limits: { current: {} as Partial<Limits> },
}))

vi.mock('../../lib/auth', async () => ({
  useAuth: useAuthMock,
  authModeFromUser: (await import('../../lib/auth/types')).authModeFromUser,
}))
vi.mock('../../lib/hooks/useLimits', () => ({ useLimits: () => ({ data: limits.current }) }))
vi.mock('./DiscordNotifications', () => ({ DiscordNotifications: () => null }))
vi.mock('./ApiKeySettings', () => ({ ApiKeySettings: () => null }))
vi.mock('./DevicesPanel', () => ({ DevicesPanel: () => null }))
vi.mock('./InvitesPanel', () => ({ InvitesPanel: () => null }))
vi.mock('./PreferencesPanel', () => ({ PreferencesPanel: () => null }))

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
  render(
    <ConfirmProvider>
      <UserMenu />
    </ConfirmProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /guest/i }))
}

beforeEach(() => {
  useAuthMock.mockReturnValue(auth({}))
  limits.current = {}
  // jsdom lacks <dialog> showModal/close; the confirm modal only reads d.open.
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
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

describe('UserMenu — account details and self-deletion', () => {
  it('names the provider the session signed in with', () => {
    useAuthMock.mockReturnValue(auth({ user: { sub: 'apple:abc', username: 'guest' } }))
    openMenu()
    expect(screen.getByText('Signed in with Apple as')).toBeInTheDocument()
  })

  it('hides Delete account unless the server reports accountDeletionEnabled', () => {
    openMenu()
    expect(screen.queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument()
  })

  it('deletes, clears eex./guide. storage and signs out on 204', async () => {
    limits.current = { accountDeletionEnabled: true }
    const signOut = vi.fn().mockResolvedValue(undefined)
    useAuthMock.mockReturnValue(auth({ signOut }))
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    localStorage.setItem('eex.suggestionMode', 'trending')
    localStorage.setItem('guide.categoryIds', '1,2')
    localStorage.setItem('other.key', 'kept')

    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete account' }))

    await vi.waitFor(() => expect(signOut).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/account\/self$/),
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
    expect(localStorage.getItem('eex.suggestionMode')).toBeNull()
    expect(localStorage.getItem('guide.categoryIds')).toBeNull()
    expect(localStorage.getItem('other.key')).toBe('kept')
  })

  it('explains a 409 last_admin refusal and changes nothing', async () => {
    limits.current = { accountDeletionEnabled: true }
    const signOut = vi.fn().mockResolvedValue(undefined)
    useAuthMock.mockReturnValue(auth({ signOut }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'last_admin' }, { status: 409 })))
    localStorage.setItem('eex.suggestionMode', 'trending')

    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete account' }))

    expect(await screen.findByText(/you are its last administrator/)).toBeInTheDocument()
    expect(signOut).not.toHaveBeenCalled()
    expect(localStorage.getItem('eex.suggestionMode')).toBe('trending')
  })
})
