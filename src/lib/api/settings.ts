// Client for the per-user settings routes (server/routes/settings.ts).
// The BYO Anthropic key is stored server-side, encrypted at rest; these
// calls only ever carry the key INTO the server (PUT) — every read path
// returns the masked info shape, never the key itself.

import { apiUrl } from './base'
import { throwApiError } from './errors'

export type AnthropicKeyInfo = { set: boolean; last4?: string }

const PATH = '/api/settings/anthropic-key'
const SCOPE = 'Settings /anthropic-key'
const EXPECTED_SUB_HEADER = 'X-EEX-Expected-Sub'

export async function getAnthropicKeyInfo(options?: {
  signal?: AbortSignal
}): Promise<AnthropicKeyInfo> {
  const r = await fetch(apiUrl(PATH), {
    credentials: 'include',
    signal: options?.signal,
  })
  if (!r.ok) await throwApiError(r, SCOPE)
  return (await r.json()) as AnthropicKeyInfo
}

export async function putAnthropicKey(
  key: string,
  options: { expectedSub: string; signal?: AbortSignal },
): Promise<AnthropicKeyInfo> {
  const r = await fetch(apiUrl(PATH), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      [EXPECTED_SUB_HEADER]: options.expectedSub,
    },
    credentials: 'include',
    body: JSON.stringify({ key }),
    signal: options.signal,
  })
  if (!r.ok) await throwApiError(r, SCOPE)
  return (await r.json()) as AnthropicKeyInfo
}

export async function deleteAnthropicKey(options: {
  expectedSub: string
  signal?: AbortSignal
}): Promise<AnthropicKeyInfo> {
  const r = await fetch(apiUrl(PATH), {
    method: 'DELETE',
    headers: { [EXPECTED_SUB_HEADER]: options.expectedSub },
    credentials: 'include',
    signal: options.signal,
  })
  if (!r.ok) await throwApiError(r, SCOPE)
  return (await r.json()) as AnthropicKeyInfo
}
