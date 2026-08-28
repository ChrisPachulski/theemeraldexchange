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

/** Social providers we deep-link straight to (skipping the hosted chooser).
 *  Keys are what the SPA sends; values are WorkOS's provider identifiers. */
export const WORKOS_PROVIDERS = {
  google: 'GoogleOAuth',
  apple: 'AppleOAuth',
} as const
export type WorkosProvider = keyof typeof WORKOS_PROVIDERS

/** AuthKit login URL. `state` is the CSRF nonce the callback compares against
 *  its cookie; `provider` deep-links to Google/Apple, else the hosted UI. */
export function workosAuthorizationUrl(
  state: string,
  provider?: WorkosProvider,
  native?: { redirectUri: string; codeChallenge: string },
): string {
  const url = new URL(WORKOS_AUTHORIZE_URL)
  url.searchParams.set('client_id', env.workosClientId ?? '')
  url.searchParams.set('redirect_uri', native?.redirectUri ?? env.workosRedirectUri ?? '')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('provider', provider ? WORKOS_PROVIDERS[provider] : 'authkit')
  url.searchParams.set('state', state)
  if (native) {
    // PKCE (public client): the app proves possession of the verifier at
    // exchange time, so a code intercepted on the custom-scheme redirect is
    // useless on its own.
    url.searchParams.set('code_challenge', native.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

/** Trade the callback's authorization code for the WorkOS user. */
export async function exchangeWorkosCode(
  code: string,
  codeVerifier?: string,
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
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
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
