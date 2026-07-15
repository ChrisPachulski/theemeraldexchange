// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './auth'

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

function AuthProbe() {
  const { signIn, user, signInError } = useAuth()
  return (
    <>
      <button type="button" onClick={() => void signIn()}>
        Start Plex sign-in
      </button>
      <button type="button" onClick={() => void signIn('A'.repeat(20))}>
        Start with incomplete invite
      </button>
      <output aria-label="signed-in user">{user?.username ?? ''}</output>
      {signInError && <p role="alert">{signInError}</p>}
    </>
  )
}

describe('Plex popup completion', () => {
  let poll: (() => Promise<void>) | undefined
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } }
  let fetchMock: ReturnType<typeof vi.fn>
  let plexCheckResponses: unknown[]

  const authorized = {
    status: 'authorized',
    user: { sub: 'plex:42', username: 'brother', role: 'user', auth_mode: 'plex' },
  }

  beforeEach(() => {
    popup = { closed: false, close: vi.fn(), location: { href: '' } }
    plexCheckResponses = [authorized]
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      poll = handler as unknown as () => Promise<void>
      return 1 as unknown as ReturnType<typeof window.setInterval>
    })

    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/me')) return json({ error: 'unauthenticated' }, 401)
        if (url.endsWith('/api/auth/methods')) {
          return json({ plex: true, apple: false, google: false, passkey: true })
        }
        if (url.endsWith('/api/setup/status')) return json({ claimable: false })
        if (url.endsWith('/api/auth/plex/config')) {
          return json({ clientId: 'client-id', product: 'The Emerald Exchange' })
        }
        if (url.startsWith('https://plex.tv/api/v2/pins?')) {
          return json({ id: 123, code: 'plex-code', authToken: null }, 201)
        }
        if (url.endsWith('/api/auth/plex/check')) {
          return json(plexCheckResponses.shift() ?? { status: 'pending' })
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('accepts an authorized PIN even when the Plex popup has just closed', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start Plex sign-in' }))
    await act(async () => {
      // signIn awaits config fetch + JSON, then PIN fetch + JSON before
      // installing the poller. Flush those promise turns without advancing
      // the mocked interval itself.
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls, urls.join(',')).toContain('https://plex.tv/api/v2/pins?strong=true')
    expect(popup.location.href).toContain('app.plex.tv/auth')
    expect(poll).toBeTypeOf('function')

    popup.closed = true
    await act(async () => {
      await poll?.()
    })

    expect(screen.getByLabelText('signed-in user')).toHaveTextContent('brother')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps polling briefly after the popup closes while Plex propagates the token', async () => {
    plexCheckResponses = [{ status: 'pending' }, authorized]
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start Plex sign-in' }))
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })
    expect(poll).toBeTypeOf('function')

    popup.closed = true
    await act(async () => {
      await poll?.()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      await poll?.()
    })
    expect(screen.getByLabelText('signed-in user')).toHaveTextContent('brother')
  })

  it('rejects an incomplete invite before opening Plex', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start with incomplete invite' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.open).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invite codes are 22 characters. Paste the complete code.',
    )
  })
})
