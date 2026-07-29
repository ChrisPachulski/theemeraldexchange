// PII scrubber for outgoing telemetry events.
//
// The deep walker (key denylist + string token rules) is the canonical
// Rust implementation in emerald-contracts::telemetry, consumed here via
// the N-API binding's piiScrubValue. The binding is hard-required — same
// posture as every other contracts consumer (session.ts, internalPrincipal.ts):
// contractsBinding.ts throws at import time when the addon is missing, so
// there is no silent-fallback path that could drift from the contract.
// tests/vectors/telemetry-pii-scrub.json is the behavioral oracle for the
// TS, Rust and Python surfaces.
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
// Classes 1-4 and 7 are enforced by the Rust walker (the key denylist is
// emerald-contracts::telemetry::PII_KEYS — a superset of the §15.3 keys
// plus the Sentry Python EventScrubber DEFAULT_DENYLIST). Classes 5-6 are
// header-shaped rules applied on top in scrubHeaders() below; in practice
// the denylist already redacts the whole authorization/cookie header value
// via the 'auth'/'cookie' key substrings — the header pass is defense in
// depth for renamed header containers.
//
// Sentry.setUser() prohibition — §15.2, §15.4 (App Store "linked=No" label):
//   DO NOT call Sentry.setUser() with plex sub, device.id, or any persistent
//   ID — breaks the `linked=No` App Store privacy label and violates §15.2.
//   Use setSentryUser() exported below for all user-context writes; it throws
//   if a persistent-ID-shaped value is passed, catching violations at dev time.

import type { Breadcrumb, BreadcrumbHint, ErrorEvent, EventHint } from '@sentry/node'
import * as Sentry from '@sentry/node'
import { contracts } from './contractsBinding.js'

// Sentry's NodeFetch breadcrumb records the full outbound URL. Plex PIN ids
// are bearer-adjacent login artifacts: with the public client id they can be
// polled for an attached token. These URL-specific rules supplement the
// cross-language value scrubber for SDK-generated request/breadcrumb strings.
const PLEX_PIN_URL_RE = /((?:https?:\/\/plex\.tv)?\/api\/v2\/pins\/)\d+/gi
const AUTH_QUERY_SECRET_RE =
  /([?&](?:pinId|inviteCode|invite_code|setupToken|idToken|id_token)=)[^&#\s"']+/gi

function scrubSensitiveUrlArtifacts(json: string): string {
  return json
    .replace(PLEX_PIN_URL_RE, '$1REDACTED')
    .replace(AUTH_QUERY_SECRET_RE, '$1REDACTED')
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

// Deep-walk any JSON-compatible value through the canonical Rust scrubber.
// Returns a new value — never mutates the input. The JSON round-trip is
// the binding's boundary contract (piiScrubValue is stringly-typed so the
// addon doesn't need a napi object-graph walker); Sentry events are JSON
// payloads at transport time so the round-trip is lossless for them.
function scrubValue(value: unknown): unknown {
  const json = JSON.stringify(value)
  // JSON.stringify yields undefined for undefined/functions/symbols — the
  // walker has nothing to scrub in those, pass them through untouched.
  if (json === undefined) return value
  const contractScrubbed = contracts.piiScrubValue(json)
  return JSON.parse(scrubSensitiveUrlArtifacts(contractScrubbed)) as unknown
}

// Scrub a single string value (stream-grant t=<token> and JWE-compact
// rules). Same Rust walker — a bare string is a valid JSON document.
function scrubString(value: string): string {
  return scrubValue(value) as string
}

// Public entry point for non-SDK telemetry paths (the server-side Glitchtip
// relay in serverTelemetry.ts). Applies the SAME deep walker the SDK beforeSend
// uses — the PII_KEYS denylist on object keys + the token/JWE regex rules on
// strings — so a hand-built relay payload is held to the same §15.3 redaction
// as the SDK path instead of bypassing it.
export function scrubTelemetryValue(value: unknown): unknown {
  return scrubValue(value)
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
  // Deep-scrub all extra/contexts/tags/user data via the canonical walker.
  // This covers the PII_KEYS denylist and the regex rules.
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
