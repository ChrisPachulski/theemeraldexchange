// @vitest-environment jsdom
//
// Mounted-hook tests for useUserApiKey — the server-side BYO-key flow.
// The settings API client is mocked at the module boundary; localStorage
// is jsdom's real implementation, seeded per test to exercise the
// one-time silent migration from the legacy plaintext-localStorage model.

import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useUserApiKey } from './useUserApiKey'
import { SESSION_EXPIRED_EVENT } from '../queryClient'

const { getInfoMock, putKeyMock, deleteKeyMock, useAuthMock } = vi.hoisted(() => ({
  getInfoMock: vi.fn(),
  putKeyMock: vi.fn(),
  deleteKeyMock: vi.fn(),
  useAuthMock: vi.fn(),
}))

vi.mock('../api/settings', () => ({
  getAnthropicKeyInfo: getInfoMock,
  putAnthropicKey: putKeyMock,
  deleteAnthropicKey: deleteKeyMock,
}))
vi.mock('../auth', () => ({ useAuth: useAuthMock }))

const SUB = 'plex:1'
const SCOPED = `eex.apiKey.${SUB}`
const LEGACY = 'eex.apiKey'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  localStorage.clear()
  useAuthMock.mockReturnValue({ user: { sub: SUB, username: 'guest' } })
  getInfoMock.mockResolvedValue({ set: false })
  putKeyMock.mockResolvedValue({ set: true, last4: 'abcd' })
  deleteKeyMock.mockResolvedValue({ set: false })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useUserApiKey — server state', () => {
  it('reflects a stored key as hasKey + masked fingerprint, never the key', async () => {
    getInfoMock.mockResolvedValue({ set: true, last4: 'wxyz' })
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(result.current.hasKey).toBe(true))
    expect(result.current.fingerprint).toBe('wxyz')
    expect(JSON.stringify(result.current)).not.toContain('sk-ant-')
  })

  it('reports no key when the server has none', async () => {
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasKey).toBe(false)
    expect(result.current.fingerprint).toBeNull()
  })
})

describe('useUserApiKey — one-time silent localStorage migration', () => {
  it('PUTs a scoped localStorage key to the server and removes it locally', async () => {
    localStorage.setItem(SCOPED, 'sk-ant-local-key-abcd')
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(putKeyMock).toHaveBeenCalledWith('sk-ant-local-key-abcd'))
    await waitFor(() => expect(localStorage.getItem(SCOPED)).toBeNull())
    await waitFor(() => expect(result.current.hasKey).toBe(true))
    expect(result.current.fingerprint).toBe('abcd')
  })

  it('migrates the legacy unscoped slot too and clears both', async () => {
    localStorage.setItem(LEGACY, 'sk-ant-legacy-key-abcd')
    renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(putKeyMock).toHaveBeenCalledWith('sk-ant-legacy-key-abcd'))
    await waitFor(() => expect(localStorage.getItem(LEGACY)).toBeNull())
  })

  it('does not overwrite a key already stored server-side; just drops the local copy', async () => {
    getInfoMock.mockResolvedValue({ set: true, last4: 'srvr' })
    localStorage.setItem(SCOPED, 'sk-ant-stale-local-copy')
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(localStorage.getItem(SCOPED)).toBeNull())
    expect(putKeyMock).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.fingerprint).toBe('srvr'))
  })

  it('keeps the local copy when the migration PUT fails (retries next mount)', async () => {
    localStorage.setItem(SCOPED, 'sk-ant-local-key-abcd')
    putKeyMock.mockRejectedValue(new Error('server down'))
    renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(putKeyMock).toHaveBeenCalled())
    expect(localStorage.getItem(SCOPED)).toBe('sk-ant-local-key-abcd')
  })

  it('dispatches session expiry when the migration PUT fails with an unauthenticated 401', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    localStorage.setItem(SCOPED, 'sk-ant-local-key-abcd')
    putKeyMock.mockRejectedValue(
      Object.assign(new Error('expired'), { status: 401, code: 'unauthenticated' }),
    )

    renderHook(() => useUserApiKey(), { wrapper })

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem(SCOPED)).toBe('sk-ant-local-key-abcd')
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })

  it('does not dispatch when migration sees a non-session 401', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    localStorage.setItem(SCOPED, 'sk-ant-local-key-abcd')
    putKeyMock.mockRejectedValue(
      Object.assign(new Error('upstream key rejected'), {
        status: 401,
        code: 'upstream_unauthorized',
      }),
    )

    renderHook(() => useUserApiKey(), { wrapper })

    await waitFor(() => expect(putKeyMock).toHaveBeenCalled())
    expect(listener).not.toHaveBeenCalled()
    expect(localStorage.getItem(SCOPED)).toBe('sk-ant-local-key-abcd')
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })

  it('does nothing when no local key exists', async () => {
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(putKeyMock).not.toHaveBeenCalled()
  })
})

describe('useUserApiKey — mutations', () => {
  it('setKey trims and PUTs, then exposes the new fingerprint', async () => {
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await result.current.setKey('  sk-ant-fresh-key-abcd  ')
    expect(putKeyMock).toHaveBeenCalledWith('sk-ant-fresh-key-abcd')
    await waitFor(() => expect(result.current.hasKey).toBe(true))
    expect(result.current.fingerprint).toBe('abcd')
  })

  it('clearKey DELETEs and drops the fingerprint', async () => {
    getInfoMock.mockResolvedValue({ set: true, last4: 'wxyz' })
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(result.current.hasKey).toBe(true))
    await result.current.clearKey()
    expect(deleteKeyMock).toHaveBeenCalled()
    await waitFor(() => expect(result.current.hasKey).toBe(false))
    expect(result.current.fingerprint).toBeNull()
  })

  it('setKey surfaces server rejection to the caller', async () => {
    putKeyMock.mockRejectedValue(new Error('invalid_key'))
    const { result } = renderHook(() => useUserApiKey(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await expect(result.current.setKey('sk-ant-bad')).rejects.toThrow('invalid_key')
  })
})
