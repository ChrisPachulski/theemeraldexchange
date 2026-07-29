// Thin loader + wrapper around Apple's official Sign in with Apple JS
// SDK (appleid.auth.js). The SDK is loaded lazily from Apple's CDN the
// first time the user clicks the button, so the public bundle never
// ships a script tag for a flow most visitors won't use, and a missing
// Apple config simply yields a graceful "unavailable" rather than a hard
// failure.
//
// The native iOS/tvOS path (M2/Xcode-gated) does NOT use this — it uses
// ASAuthorization and posts the identity token to the same /api/auth/apple
// endpoint. This module is the web SPA path only.

const SDK_SRC =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'

// Minimal shape of the global the SDK installs. We only touch the two
// methods we use; `unknown` everywhere else keeps us honest.
type AppleIDAuth = {
  init: (config: {
    clientId: string
    scope: string
    redirectURI: string
    state?: string
    nonce?: string
    usePopup: boolean
  }) => void
  signIn: () => Promise<AppleSignInResponse>
}

export type AppleSignInResponse = {
  authorization: {
    id_token: string
    code: string
    state?: string
  }
  user?: {
    email?: string
    name?: { firstName?: string; lastName?: string }
  }
}

declare global {
  interface Window {
    AppleID?: { auth: AppleIDAuth }
  }
}

/** Build-time Apple Services ID used as the SIWA `client_id` / token aud.
 *  Mirrors the server's APPLE_CLIENT_ID. Absent ⇒ Apple sign-in is not
 *  configured for this deployment and the button hides itself. */
export function appleClientId(): string | null {
  const id = import.meta.env.VITE_APPLE_CLIENT_ID
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Redirect URI registered with Apple for the web Services ID. With
 *  `usePopup: true` Apple still requires a registered return URL; default
 *  to the current origin's /auth/apple/callback when unset. */
function appleRedirectUri(): string {
  const explicit = import.meta.env.VITE_APPLE_REDIRECT_URI
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return `${window.location.origin}/auth/apple/callback`
}

/** True iff the web SIWA flow is configured for this build. */
export function isAppleSignInConfigured(): boolean {
  return appleClientId() !== null
}

let sdkLoad: Promise<void> | null = null

/** Lazily injects Apple's appleid.auth.js exactly once. Resolves when
 *  `window.AppleID` is available; rejects on load error or timeout. */
export function loadAppleSdk(timeoutMs = 10_000): Promise<void> {
  if (typeof window !== 'undefined' && window.AppleID?.auth) {
    return Promise.resolve()
  }
  if (sdkLoad) return sdkLoad
  sdkLoad = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SDK_SRC}"]`,
    )
    const script = existing ?? document.createElement('script')
    let settled = false
    let timeout: number | null = null
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      script.removeEventListener('load', onReady)
      script.removeEventListener('error', onError)
      if (timeout !== null) window.clearTimeout(timeout)
      if (error) {
        script.remove()
        reject(error)
      } else {
        resolve()
      }
    }
    const onReady = () => {
      if (window.AppleID?.auth) finish()
      else finish(new Error('apple_sdk_no_global'))
    }
    const onError = () => finish(new Error('apple_sdk_load_error'))

    script.addEventListener('load', onReady)
    script.addEventListener('error', onError)
    timeout = window.setTimeout(
      () => finish(new Error('apple_sdk_timeout')),
      timeoutMs,
    )

    if (!existing) {
      script.src = SDK_SRC
      script.async = true
      document.head.appendChild(script)
    }
  }).catch((e) => {
    // Allow a later retry after a transient failure.
    sdkLoad = null
    throw e
  })
  return sdkLoad
}

/** Cryptographically random nonce for replay defense. The same value is
 *  handed to Apple (init) and echoed in the signed identity token; the
 *  server compares it constant-time. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export type AppleAuthResult = {
  identityToken: string
  nonce: string
}

/**
 * Runs the full web SIWA handshake: load SDK → init with the configured
 * Services ID → popup sign-in → return the identity token + the nonce we
 * generated. Throws on cancel / unconfigured / SDK failure so the caller
 * can surface a precise message.
 */
export async function runAppleSignIn(): Promise<AppleAuthResult> {
  const clientId = appleClientId()
  if (!clientId) throw new Error('apple_not_configured')
  await loadAppleSdk()
  const auth = window.AppleID?.auth
  if (!auth) throw new Error('apple_sdk_no_global')
  const nonce = makeNonce()
  auth.init({
    clientId,
    scope: 'name email',
    redirectURI: appleRedirectUri(),
    nonce,
    usePopup: true,
  })
  const res = await auth.signIn()
  const idToken = res?.authorization?.id_token
  if (!idToken) throw new Error('apple_no_identity_token')
  return { identityToken: idToken, nonce }
}
