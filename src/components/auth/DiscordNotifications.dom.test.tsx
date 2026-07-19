// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EXPIRED_EVENT } from '../../lib/queryClient'
import { DiscordNotifications } from './DiscordNotifications'

let expiryClock = 30_000

beforeEach(() => {
  expiryClock += 3_000
  vi.spyOn(Date, 'now').mockReturnValue(expiryClock)
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DiscordNotifications session expiry', () => {
  it('dispatches session expiry when its mount-time manual fetch gets an unauthenticated 401', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<DiscordNotifications onClose={vi.fn()} />)

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })

  it('does not dispatch when a mount-time upstream failure uses HTTP 401', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'sonarr_auth_failed' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<DiscordNotifications onClose={vi.fn()} />)

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })

  it('reports expiry from the save mutation path', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sonarr: false, radarr: false, configured: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    render(<DiscordNotifications onClose={vi.fn()} />)
    await screen.findByText('Not configured')
    fireEvent.change(screen.getByPlaceholderText('https://discord.com/api/webhooks/...'), {
      target: { value: 'https://discord.com/api/webhooks/test/value' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }))

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })

  it('reports expiry from the test mutation path', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sonarr: true, radarr: true, configured: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    render(<DiscordNotifications onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send test ping' }))

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })

  it('reports expiry from the remove mutation path', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sonarr: true, radarr: true, configured: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    render(<DiscordNotifications onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })
})
