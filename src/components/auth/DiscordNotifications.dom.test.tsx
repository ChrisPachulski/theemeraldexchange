// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EXPIRED_EVENT } from '../../lib/queryClient'
import { DiscordNotifications } from './DiscordNotifications'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DiscordNotifications session expiry', () => {
  it('dispatches session expiry when its mount-time manual fetch gets a 401', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }))

    render(<DiscordNotifications onClose={vi.fn()} />)

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })
})
