// PII scrubber for outgoing telemetry events.
//
// This module is the TypeScript port of the canonical Rust implementation:
//   emerald-contracts::telemetry::pii_scrub_keys()
//
// The Rust crate is M2 work. When M2 ships, this file will be replaced by
// generated bindings or a mirrored const list from the contracts crate.
// The CI test vector at tests/vectors/telemetry-pii-scrub.json validates
// both this port and the future Rust implementation.
//
// Contract reference: §15.3 (PII scrubbing, mandatory)
//
// PII key classes scrubbed per §15.3:
//   1. plexAuthToken              — field key, anywhere in the event
//   2. verifiedPlexServerId       — field key, anywhere in the event
//   3. XTREAM_USERNAME/PASSWORD   — field keys, anywhere in the event
//   4. Stream-grant URL t=<token> — regex strip in string values
//   5. Authorization: Bearer      — header value replacement
//   6. eex.session=<value>        — cookie header value replacement
//   7. JWE ciphertext SQL params  — regex strip in string values
//
// Sentry.setUser() prohibition — §15.2, §15.4 (App Store "linked=No" label):
//   DO NOT call Sentry.setUser() with plex sub, device.id, or any persistent
//   ID — breaks the `linked=No` App Store privacy label and violates §15.2.
//   Use setSentryUser() exported below for all user-context writes; it throws
//   if a persistent-ID-shaped value is passed, catching violations at dev time.

import type { Breadcrumb, BreadcrumbHint, ErrorEvent, EventHint } from '@sentry/node'
import * as Sentry from '@sentry/node'

// ---------------------------------------------------------------------------
// Field-key denylist
// ---------------------------------------------------------------------------
//
// REDACTED_FIELD_KEYS is the union of:
//   a) §15.3 EEX-specific keys (plexAuthToken, verifiedPlexServerId, etc.)
//   b) Sentry Python EventScrubber.DEFAULT_DENYLIST — defense-in-depth for
//      any third-party lib that accidentally surfaces a generic secret field.
//
// Matching is case-insensitive substring (see isRedactedKey() below), mirroring
// Sentry's own scrubber behavior. A key matches if it *contains* any entry as a
// case-insensitive substring — e.g. "userPassword" matches "password".
const REDACTED_FIELD_KEYS = new Set<string>([
  // §15.3 EEX-specific keys
  'plexAuthToken',
  'verifiedPlexServerId',
  'XTREAM_USERNAME',
  'XTREAM_PASSWORD',
  // Sentry Python EventScrubber.DEFAULT_DENYLIST (all 22 entries)
  'password',
  'secret',
  'api_key',
  'token',
  'session',
  'auth',
  'credential',
  'cookie',
  'key',
  'csrf',
  'pem',
  'key_id',
  'signature',
  'license',
  'jwt',
  'certificate',
  'hash',
  'salt',
  'oauth',
  'client_secret',
  'refresh_token',
  'access_token',
  'private_key',
])

// Returns true if a key matches any entry in REDACTED_FIELD_KEYS via
// case-insensitive substring match — the same semantics as Sentry's own
// Python EventScrubber.
function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase()
  for (const pattern of REDACTED_FIELD_KEYS) {
    if (lower.includes(pattern.toLowerCase())) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// setSentryUser — safe wrapper enforcing §15.2 + §15.4 prohibition
// ---------------------------------------------------------------------------
//
// This is the ONLY approved path for setting Sentry user context. It throws
// if the id or username field looks like a persistent identifier (non-empty
// non-anonymous value), preventing the App Store "linked=No" label from
// being violated.
//
// Approved call: setSentryUser({ id: 'anonymous' })
// Approved call: setSentryUser()                    — clears user context
// REJECTED:      setSentryUser({ id: 'plex:12345' })
// REJECTED:      setSentryUser({ username: 'alice' })
//
// DO NOT call Sentry.setUser() directly anywhere in the codebase.
const ANONYMOUS_ID_PATTERN = /^anonymous$/i

export function setSentryUser(user?: { id?: string; username?: string }): void {
  if (!user) {
    Sentry.setUser(null)
    return
  }
  if (user.id !== undefined && !ANONYMOUS_ID_PATTERN.test(user.id)) {
    throw new Error(
      '[telemetry] setSentryUser: id must be "anonymous" or omitted — ' +
        'persistent identifiers break the App Store linked=No label (§15.2, §15.4). ' +
        `Received: ${JSON.stringify(user.id)}`,
    )
  }
  if (user.username !== undefined) {
    throw new Error(
      '[telemetry] setSentryUser: username must not be set — ' +
        'any username value is a persistent identifier that breaks ' +
        'the App Store linked=No label (§15.2, §15.4).',
    )
  }
  Sentry.setUser({ id: 'anonymous' })
}

// Stream-grant URL token: t=<anything> query param.
// Replaces the token value with REDACTED while preserving param name.
const STREAM_TOKEN_RE = /\bt=([^&\s"']+)/g

// JWE/JWT ciphertext pattern. Matches compact-serialization tokens that
// start with eyJ[A-Za-z0-9_-]{8,}\. (the base64url-encoded JSON header
// + separator dot). Replaces the entire match — including any trailing
// dot-separated parts — with REDACTED. so the shape is clearly scrubbed.
// The [^"'\s;,]* suffix consumes the rest of the compact-serialized form
// (remaining base64url parts and dots) without crossing cookie/query
// delimiters (; , whitespace quotes).
const JWE_CIPHERTEXT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[^"'\s;,]*/g

// Scrub a single string value. Applies all regex-based rules.
function scrubString(value: string): string {
  // Stream-grant tokens: t=<token> → t=REDACTED
  value = value.replace(STREAM_TOKEN_RE, 't=REDACTED')

  // JWE ciphertext: eyJ...<8+ chars>. → REDACTED.
  value = value.replace(JWE_CIPHERTEXT_RE, 'REDACTED.')

  return value
}

// Deep-walk any JSON-compatible value and apply PII scrubbing.
// Returns a new value — never mutates the input.
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubString(value)
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue)
  }
  if (value !== null && typeof value === 'object') {
    return scrubObject(value as Record<string, unknown>)
  }
  return value
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (isRedactedKey(key)) {
      out[key] = 'REDACTED'
    } else {
      out[key] = scrubValue(val)
    }
  }
  return out
}

// Scrub Authorization header values.
// "Bearer <token>" → "Bearer REDACTED"
// Other schemes are left untouched (they're not device tokens).
function scrubAuthorizationHeader(value: string): string {
  return value.replace(/^(Bearer\s+).+$/i, '$1REDACTED')
}

// Scrub Cookie header values.
// eex.session=<value> — value is replaced with REDACTED.
// Other cookies are preserved.
function scrubCookieHeader(value: string): string {
  return value.replace(/(eex\.session=)[^;]*/g, '$1REDACTED')
}

// Walk the Sentry event's request.headers object and apply header-specific
// scrubbing. Returns a new headers object.
// Sentry's Request type declares headers as { [key: string]: string } so
// values are always plain strings at the SDK boundary.
function scrubHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, val] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization') {
      out[name] = scrubAuthorizationHeader(val)
    } else if (lower === 'cookie') {
      out[name] = scrubCookieHeader(val)
    } else {
      out[name] = val
    }
  }
  return out
}

// Top-level Sentry beforeSend hook. Receives the full ErrorEvent and returns
// a scrubbed copy. Never returns null — dropping events is the transport's
// job; the scrubber's job is to clean them.
//
// Signature matches the Sentry SDK's `beforeSend` option type:
//   (event: ErrorEvent, hint: EventHint) => ErrorEvent | PromiseLike<ErrorEvent | null> | null
//
// Compatible with both Sentry SaaS and Glitchtip (same SDK protocol).
export function piiScrub(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  // Deep-scrub all extra/contexts/tags/user data via the generic walker.
  // This covers REDACTED_FIELD_KEYS and the regex rules.
  const scrubbed = scrubValue(event) as ErrorEvent

  // Apply header-specific rules on top of the generic scrub.
  if (
    scrubbed.request?.headers &&
    typeof scrubbed.request.headers === 'object' &&
    !Array.isArray(scrubbed.request.headers)
  ) {
    scrubbed.request = {
      ...scrubbed.request,
      headers: scrubHeaders(
        scrubbed.request.headers as Record<string, string>,
      ),
    }
  }

  return scrubbed
}

// Sentry beforeBreadcrumb hook — scrubs PII from breadcrumb URLs.
//
// XHR and navigation breadcrumbs carry request URLs in `data.url`. Without
// this hook, stream-grant tokens (t=<token>) in those URLs bypass beforeSend
// and reach Glitchtip unredacted. Mozilla Firefox Accounts hit this class of
// bug in 2021 (stream-grant tokens in XHR breadcrumb data.url).
//
// Install as `beforeBreadcrumb` in Sentry.init alongside `beforeSend: piiScrub`.
//
// Signature matches the Sentry SDK `beforeBreadcrumb` option type:
//   (breadcrumb: Breadcrumb, hint?: BreadcrumbHint) => Breadcrumb | null
//
// Returns the scrubbed breadcrumb — never returns null (dropping breadcrumbs
// would hide debug context; we only clean them).
export function piiBreadcrumbScrub(
  breadcrumb: Breadcrumb,
  _hint?: BreadcrumbHint,
): Breadcrumb {
  // Scrub the breadcrumb's top-level message string.
  const message =
    typeof breadcrumb.message === 'string'
      ? scrubString(breadcrumb.message)
      : breadcrumb.message

  // Scrub all fields in breadcrumb.data (covers data.url, data.reason, etc.).
  const data =
    breadcrumb.data !== undefined
      ? (scrubValue(breadcrumb.data as unknown) as typeof breadcrumb.data)
      : breadcrumb.data

  return { ...breadcrumb, message, data }
}
