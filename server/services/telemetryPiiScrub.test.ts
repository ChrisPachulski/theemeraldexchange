// Vector-driven tests for the §15.3 PII scrubber.
//
// The test vectors live at tests/vectors/telemetry-pii-scrub.json and are
// the single source of truth for what the scrubber must redact. When the
// Rust port ships in M2 the same vector file will be used by the Rust tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ErrorEvent } from '@sentry/node'

// Mock @sentry/node before importing the module under test — setSentryUser
// calls Sentry.setUser() internally and we don't want real SDK side-effects
// in unit tests.
vi.mock('@sentry/node', () => ({
  setUser: vi.fn(),
}))

import { piiBreadcrumbScrub, piiScrub, setSentryUser } from './telemetryPiiScrub.js'
import * as Sentry from '@sentry/node'

interface ScrubVector {
  id: string
  description: string
  input: Record<string, unknown>
  expected: Record<string, unknown>
}

interface VectorFile {
  _meta: Record<string, string>
  cases: ScrubVector[]
}

const vectorPath = resolve(
  new URL('../../tests/vectors/telemetry-pii-scrub.json', import.meta.url).pathname,
)

const vectors = JSON.parse(readFileSync(vectorPath, 'utf-8')) as VectorFile

// Helper: cast test inputs to ErrorEvent. The scrubber operates on the
// JSON shape of events so test inputs don't need the `type: undefined`
// discriminant that Sentry's TypeScript type requires.
function asEvent(v: unknown): ErrorEvent {
  return v as ErrorEvent
}

describe('piiScrub — §15.3 contract vectors', () => {
  for (const vec of vectors.cases) {
    it(`[${vec.id}] ${vec.description}`, () => {
      const result = piiScrub(asEvent(vec.input))
      expect(result).toEqual(vec.expected)
    })
  }
})

// Extra unit tests not covered by the vector file — edge cases that are
// awkward to express as JSON vectors.

describe('piiScrub — extra edge cases', () => {
  it('leaves non-PII string fields untouched', () => {
    const event = asEvent({ message: 'Hello world', extra: { foo: 'bar' } })
    expect(piiScrub(event)).toEqual(event)
  })

  it('scrubs nested plexAuthToken deep in the tree', () => {
    const event = asEvent({
      extra: {
        nested: {
          deeply: {
            plexAuthToken: 'secret',
          },
        },
      },
    })
    const result = piiScrub(event) as unknown as {
      extra: { nested: { deeply: { plexAuthToken: string } } }
    }
    expect(result.extra.nested.deeply.plexAuthToken).toBe('REDACTED')
  })

  it('scrubs multiple t= params in one URL', () => {
    const event = asEvent({
      request: {
        url: '/stream?t=token1&other=ok&t=token2',
      },
    })
    const result = piiScrub(event) as unknown as {
      request: { url: string }
    }
    expect(result.request.url).toBe('/stream?t=REDACTED&other=ok&t=REDACTED')
  })

  it('redacts Authorization headers regardless of scheme — Authorization key matches "auth" denylist substring', () => {
    // The Authorization header key contains the substring "auth" which is in
    // the extended REDACTED_FIELD_KEYS denylist (Sentry DEFAULT_DENYLIST).
    // All Authorization values — including Basic auth — are redacted. Basic auth
    // credentials (base64-encoded user:pass) are credentials and should be
    // scrubbed. This is a stricter posture than the previous §15.3 version which
    // only scrubbed Bearer tokens; the extended denylist covers the full header.
    const event = asEvent({
      request: {
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
        },
      },
    })
    const result = piiScrub(event) as unknown as {
      request: { headers: { Authorization: string } }
    }
    expect(result.request.headers.Authorization).toBe('REDACTED')
  })

  it('handles arrays of XTREAM_PASSWORD values', () => {
    const event = asEvent({
      extra: {
        list: [
          { XTREAM_PASSWORD: 'pass1' },
          { XTREAM_PASSWORD: 'pass2' },
        ],
      },
    })
    const result = piiScrub(event) as unknown as {
      extra: { list: Array<{ XTREAM_PASSWORD: string }> }
    }
    expect(result.extra.list[0].XTREAM_PASSWORD).toBe('REDACTED')
    expect(result.extra.list[1].XTREAM_PASSWORD).toBe('REDACTED')
  })
})

// ---------------------------------------------------------------------------
// piiBreadcrumbScrub — §15.3 beforeBreadcrumb hook (SYNTHESIS #2)
// ---------------------------------------------------------------------------

describe('piiBreadcrumbScrub — §15.3 breadcrumb scrubber', () => {
  it('scrubs t=<token> in breadcrumb data.url', () => {
    const breadcrumb = {
      type: 'http',
      category: 'xhr',
      data: {
        url: 'https://nas.local/api/iptv/stream/live/42?t=eyJsecret123&quality=hd',
        method: 'GET',
      },
    }
    const result = piiBreadcrumbScrub(breadcrumb)
    expect((result.data as { url: string }).url).toBe(
      'https://nas.local/api/iptv/stream/live/42?t=REDACTED&quality=hd',
    )
  })

  it('scrubs t=<token> in breadcrumb message string', () => {
    const breadcrumb = {
      type: 'default',
      message: 'Fetched /stream?t=abc123&quality=sd',
    }
    const result = piiBreadcrumbScrub(breadcrumb)
    expect(result.message).toBe('Fetched /stream?t=REDACTED&quality=sd')
  })

  it('leaves breadcrumbs without PII untouched', () => {
    const breadcrumb = {
      type: 'default',
      message: 'Navigation to /home',
      data: { from: '/login', to: '/home' },
    }
    const result = piiBreadcrumbScrub(breadcrumb)
    expect(result).toEqual(breadcrumb)
  })

  it('does not return null — always returns a breadcrumb', () => {
    const breadcrumb = { type: 'default', message: 'safe breadcrumb' }
    const result = piiBreadcrumbScrub(breadcrumb)
    expect(result).not.toBeNull()
    expect(result.message).toBe('safe breadcrumb')
  })

  it('scrubs JWE ciphertext in breadcrumb data fields — key-level match wins', () => {
    // The key 'token' matches the denylist substring 'token' so the entire
    // field is redacted to 'REDACTED' by key-level scrubbing — the JWE regex
    // only fires on string values whose key did not match the denylist.
    const breadcrumb = {
      type: 'default',
      data: {
        token: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.abc123.def456.ghi789.jkl012',
      },
    }
    const result = piiBreadcrumbScrub(breadcrumb)
    expect((result.data as { token: string }).token).toBe('REDACTED')
  })
})

// ---------------------------------------------------------------------------
// setSentryUser — §15.2 / §15.4 persistent-ID prohibition
// ---------------------------------------------------------------------------

describe('setSentryUser — §15.2 §15.4 setUser prohibition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls Sentry.setUser(null) when called with no argument', () => {
    setSentryUser()
    expect(Sentry.setUser).toHaveBeenCalledWith(null)
  })

  it('calls Sentry.setUser({ id: "anonymous" }) when passed { id: "anonymous" }', () => {
    setSentryUser({ id: 'anonymous' })
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'anonymous' })
  })

  it('calls Sentry.setUser({ id: "anonymous" }) when passed { id: "ANONYMOUS" } (case-insensitive)', () => {
    setSentryUser({ id: 'ANONYMOUS' })
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'anonymous' })
  })

  it('throws when id is a Plex sub', () => {
    expect(() => setSentryUser({ id: 'plex:12345' })).toThrow(
      /persistent identifiers break the App Store linked=No label/,
    )
    expect(Sentry.setUser).not.toHaveBeenCalled()
  })

  it('throws when id is a device UUID', () => {
    expect(() =>
      setSentryUser({ id: '01J0T1ZQ5GZ1F3MNHJRGV80W12' }),
    ).toThrow(/persistent identifiers/)
    expect(Sentry.setUser).not.toHaveBeenCalled()
  })

  it('throws when username is set (any value)', () => {
    expect(() => setSentryUser({ username: 'alice' })).toThrow(
      /username must not be set/,
    )
    expect(Sentry.setUser).not.toHaveBeenCalled()
  })

  it('throws when both id and username are set', () => {
    expect(() =>
      setSentryUser({ id: 'plex:99', username: 'alice' }),
    ).toThrow()
    expect(Sentry.setUser).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Extended REDACTED_FIELD_KEYS — Sentry DEFAULT_DENYLIST coverage (SYNTHESIS #5)
// ---------------------------------------------------------------------------

describe('piiScrub — extended denylist (Sentry DEFAULT_DENYLIST)', () => {
  const genericKeyTests: Array<[string, string]> = [
    ['password', 'mypassword'],
    ['userPassword', 'mypassword'],
    ['secret', 'mysecret'],
    ['api_key', 'apikey123'],
    ['token', 'tok-abc'],
    ['session', 'sess-xyz'],
    ['auth', 'bearer-abc'],
    ['credential', 'cred-abc'],
    ['cookie', 'cookie-val'],
    ['csrf', 'csrf-token'],
    ['jwt', 'eyJ...'],
    ['private_key', '-----BEGIN'],
    ['access_token', 'acc-tok'],
    ['refresh_token', 'ref-tok'],
    ['client_secret', 'cs-abc'],
  ]

  for (const [key, value] of genericKeyTests) {
    it(`redacts field key "${key}"`, () => {
      const event = asEvent({ extra: { [key]: value, safe: 'ok' } })
      const result = piiScrub(event) as unknown as {
        extra: Record<string, string>
      }
      expect(result.extra[key]).toBe('REDACTED')
      expect(result.extra['safe']).toBe('ok')
    })
  }
})
