// WorkOS AuthKit code exchange.
//
// The redirect-flow sibling of appleAuth.ts / googleAuth.ts. AuthKit hosts
// the login page (Apple, Google, magic link, ... whatever the dashboard
// enables); we only ever see an authorization code on our callback and
// trade it server-to-server for the WorkOS user. Proves IDENTITY ONLY —
// the verified `workos:<user_id>` sub still has to clear the shared
// invite/members allowlist downstream.
//
// Security invariants: the API key is the exchange secret and lives only
// in env; the WorkOS URLs are hardcoded constants (no SSRF); the only sub
// that leaves this module is parseSub-validated from WorkOS's response;
// the exchange is bounded by a 15s timeout (the runbook's non-interactive
// provider leg budget).
//
// Reference: https://workos.com/docs/reference/authkit/authenticate/code

import { parseSub, type Sub } from './sub.js'
import { env } from '../env.js'

const WORKOS_AUTHORIZE_URL = 'https://api.workos.com/user_management/authorize'
const WORKOS_AUTHENTICATE_URL = 'https://api.workos.com/user_management/authenticate'
const EXCHANGE_TIMEOUT_MS = 15_000

export type WorkosVerifyError = 'provider_unavailable' | 'code_invalid' | 'bad_subject'

export type WorkosVerified = {
  ok: true
  sub: Sub
  email: string | null
  name: string | null
}

/** AuthKit hosted-login URL. `state` is the CSRF nonce the callback compares
 *  against its cookie; `provider=authkit` routes through the hosted UI. */
export function workosAuthorizationUrl(state: string): string {
  const url = new URL(WORKOS_AUTHORIZE_URL)
  url.searchParams.set('client_id', env.workosClientId ?? '')
  url.searchParams.set('redirect_uri', env.workosRedirectUri ?? '')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('provider', 'authkit')
  url.searchParams.set('state', state)
  return url.toString()
}

/** Trade the callback's authorization code for the WorkOS user. */
export async function exchangeWorkosCode(
  code: string,
): Promise<WorkosVerified | { ok: false; error: WorkosVerifyError }> {
  let res: Response
  try {
    res = await fetch(WORKOS_AUTHENTICATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: env.workosClientId,
        client_secret: env.workosApiKey,
        grant_type: 'authorization_code',
        code,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: 'provider_unavailable' }
  }
  if (res.status >= 500) return { ok: false, error: 'provider_unavailable' }
  if (!res.ok) return { ok: false, error: 'code_invalid' }

  let body: { user?: { id?: unknown; email?: unknown; first_name?: unknown; last_name?: unknown } }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return { ok: false, error: 'code_invalid' }
  }
  const user = body.user
  if (typeof user?.id !== 'string') return { ok: false, error: 'bad_subject' }

  let sub: Sub
  try {
    sub = parseSub(`workos:${user.id}`)
  } catch {
    return { ok: false, error: 'bad_subject' }
  }
  const nameParts = [user.first_name, user.last_name].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== '',
  )
  return {
    ok: true,
    sub,
    email: typeof user.email === 'string' ? user.email : null,
    name: nameParts.length > 0 ? nameParts.join(' ') : null,
  }
}
