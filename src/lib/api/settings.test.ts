// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EXPIRED_EVENT } from '../queryClient'
import { deleteAnthropicKey, putAnthropicKey } from './settings'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('settings API principal binding', () => {
  it.each([
    {
      method: 'PUT',
      call: (signal: AbortSignal) =>
        putAnthropicKey('sk-ant-test-key', { expectedSub: 'plex:1', signal }),
    },
    {
      method: 'DELETE',
      call: (signal: AbortSignal) =>
        deleteAnthropicKey({ expectedSub: 'plex:1', signal }),
    },
  ])('sends expected principal and caller signal on $method', async ({ method, call }) => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ set: false })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await call(controller.signal)

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe(method)
    expect(new Headers(init.headers).get('X-EEX-Expected-Sub')).toBe('plex:1')
    expect(init.signal).toBe(controller.signal)
  })

  it('surfaces a mismatched principal as a typed 409 without session-expiry signaling', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(json({ error: 'principal_changed' }, 409)),
    ))

    await expect(
      deleteAnthropicKey({ expectedSub: 'plex:old' }),
    ).rejects.toMatchObject({ status: 409, code: 'principal_changed' })
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })
})
