// Client for the per-user settings routes (server/routes/settings.ts).
// The BYO Anthropic key is stored server-side, encrypted at rest; these
// calls only ever carry the key INTO the server (PUT) — every read path
// returns the masked info shape, never the key itself.

import { apiUrl } from './base'
import { throwApiError } from './errors'

export type AnthropicKeyInfo = { set: boolean; last4?: string }

const PATH = '/api/settings/anthropic-key'
const SCOPE = 'Settings /anthropic-key'

export async function getAnthropicKeyInfo(): Promise<AnthropicKeyInfo> {
  const r = await fetch(apiUrl(PATH), { credentials: 'include' })
  if (!r.ok) await throwApiError(r, SCOPE)
  return (await r.json()) as AnthropicKeyInfo
}

export async function putAnthropicKey(key: string): Promise<AnthropicKeyInfo> {
  const r = await fetch(apiUrl(PATH), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ key }),
  })
  if (!r.ok) await throwApiError(r, SCOPE)
  return (await r.json()) as AnthropicKeyInfo
}

export async function deleteAnthropicKey(): Promise<AnthropicKeyInfo> {
  const r = await fetch(apiUrl(PATH), { method: 'DELETE', credentials: 'include' })
  if (!r.ok) await throwApiError(r, SCOPE)
  return (await r.json()) as AnthropicKeyInfo
}
