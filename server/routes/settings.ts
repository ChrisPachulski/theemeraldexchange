// Per-user settings. Admin-free: every authenticated household member
// manages their OWN rows only (scoped by session.sub).
//
// Currently one setting: the BYO Anthropic API key that powers the
// legacy (non-local-recommender) personalized-suggestions path. The key
// is stored encrypted at rest (services/userApiKeys.ts) and is never
// returned by any endpoint here — GET exposes only a set flag plus the
// masked last-4 fingerprint for the "replace or clear?" UI.
//
// CSRF: PUT/DELETE are covered by the app-level requireSafeOrigin gate
// (state-changing methods must present an allowlisted Origin). The GET
// is side-effect-free and returns only the masked fingerprint.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { parseLimitedJson } from '../services/parseLimitedJson.js'
import {
  deleteUserApiKey,
  getUserApiKeyInfo,
  isPlausibleAnthropicKey,
  setUserApiKey,
} from '../services/userApiKeys.js'

// A pasted API key is well under 1 KB; anything bigger is hostile or a
// paste accident. Bounded so the body read can't balloon memory.
const MAX_BODY_BYTES = 4 * 1024

export const settings = new Hono<Env>()

settings.use('*', requireAuth)

settings.get('/anthropic-key', (c) => {
  const session = c.get('session')
  return c.json(getUserApiKeyInfo(session.sub))
})

settings.put('/anthropic-key', async (c) => {
  const session = c.get('session')
  const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = (parsed.body ?? {}) as { key?: unknown }
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!isPlausibleAnthropicKey(key)) {
    // Deliberately does not echo the submitted value back — never put
    // (even an invalid) credential in a response or a log line.
    return c.json(
      { error: 'invalid_key', hint: 'expected an sk-ant-… Anthropic API key' },
      400,
    )
  }
  setUserApiKey(session.sub, key)
  return c.json(getUserApiKeyInfo(session.sub))
})

settings.delete('/anthropic-key', (c) => {
  const session = c.get('session')
  deleteUserApiKey(session.sub)
  return c.json({ set: false })
})
