// @vitest-environment jsdom
//
// Mounted tests for the "Your AI key" card. useUserApiKey is mocked at
// the module boundary (its own behavior is covered in
// useUserApiKey.dom.test.tsx); these pin the UI contract: masked
// fingerprint display (never the key), and the set / replace / clear
// affordances.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiKeySettings } from './ApiKeySettings'

const { useUserApiKeyMock, setKeyMock, clearKeyMock } = vi.hoisted(() => ({
  useUserApiKeyMock: vi.fn(),
  setKeyMock: vi.fn(),
  clearKeyMock: vi.fn(),
}))

vi.mock('../../lib/hooks/useUserApiKey', () => ({ useUserApiKey: useUserApiKeyMock }))

function mount(
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <ApiKeySettings />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setKeyMock.mockResolvedValue(undefined)
  clearKeyMock.mockResolvedValue(undefined)
  // The usage panel fetches /api/usage/me when a key is set.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(null), { status: 200 })),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('ApiKeySettings — key set', () => {
  beforeEach(() => {
    useUserApiKeyMock.mockReturnValue({
      hasKey: true,
      fingerprint: 'wxyz',
      loading: false,
      setKey: setKeyMock,
      clearKey: clearKeyMock,
    })
  })

  it('shows the masked fingerprint and never a full key', () => {
    const { container } = mount()
    expect(screen.getByText('wxyz')).toBeInTheDocument()
    expect(screen.getByText('saved to your account')).toBeInTheDocument()
    expect(container.textContent).not.toContain('sk-ant-wxyz')
    // No key entry form until the user asks to replace.
    expect(screen.queryByPlaceholderText('sk-ant-…')).not.toBeInTheDocument()
  })

  it('Replace reveals the entry form and submits a new key', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    const input = screen.getByPlaceholderText('sk-ant-…')
    fireEvent.change(input, { target: { value: 'sk-ant-new-key-1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace', hidden: false }))
    await waitFor(() => expect(setKeyMock).toHaveBeenCalledWith('sk-ant-new-key-1234'))
  })

  it('Clear calls clearKey', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(clearKeyMock).toHaveBeenCalled())
  })

  it('surfaces a usage 401 as a status-carrying query error', async () => {
    const errors: unknown[] = []
    const qc = new QueryClient({
      queryCache: new QueryCache({ onError: (error) => errors.push(error) }),
      defaultOptions: { queries: { retry: false } },
    })
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    mount(qc)

    await waitFor(() => expect(errors[0]).toMatchObject({ status: 401 }))
  })

  it('keeps the empty usage fallback for an upstream 5xx response', async () => {
    const errors: unknown[] = []
    const qc = new QueryClient({
      queryCache: new QueryCache({ onError: (error) => errors.push(error) }),
      defaultOptions: { queries: { retry: false } },
    })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 502 }))

    mount(qc)

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Set · 0 calls · $0.00')).toBeInTheDocument()
    expect(errors).toEqual([])
  })
})

describe('ApiKeySettings — no key', () => {
  beforeEach(() => {
    useUserApiKeyMock.mockReturnValue({
      hasKey: false,
      fingerprint: null,
      loading: false,
      setKey: setKeyMock,
      clearKey: clearKeyMock,
    })
  })

  it('shows the entry form and saves a pasted key', async () => {
    mount()
    const input = screen.getByPlaceholderText('sk-ant-…')
    fireEvent.change(input, { target: { value: 'sk-ant-first-key-1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setKeyMock).toHaveBeenCalledWith('sk-ant-first-key-1234'))
  })

  it('rejects a paste without the sk-ant- prefix before any request', () => {
    mount()
    fireEvent.change(screen.getByPlaceholderText('sk-ant-…'), {
      target: { value: 'not-a-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Key should start with "sk-ant-".')).toBeInTheDocument()
    expect(setKeyMock).not.toHaveBeenCalled()
  })

  it('surfaces a server rejection from setKey', async () => {
    setKeyMock.mockRejectedValue(new Error('invalid_key'))
    mount()
    fireEvent.change(screen.getByPlaceholderText('sk-ant-…'), {
      target: { value: 'sk-ant-rejected-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('invalid_key')).toBeInTheDocument())
  })
})
