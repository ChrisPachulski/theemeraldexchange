import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import {
  AUTH_OUTCOME_PHASES,
  AUTH_OUTCOME_PROVIDERS,
  AUTH_OUTCOMES,
  AUTH_OUTCOME_REASONS,
  AUTH_OUTCOME_SCOPES,
  createAuthOutcomeReporter,
  withAuthOutcome,
} from './authOutcome.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auth outcome reporter', () => {
  it('uses closed low-cardinality dimensions', () => {
    expect(AUTH_OUTCOME_PROVIDERS).toEqual(['plex', 'apple', 'google', 'passkey'])
    expect(AUTH_OUTCOME_PHASES).toEqual([
      'check',
      'identity_verify',
      'login_options',
      'login_verify',
      'register_options',
      'register_verify',
    ])
    expect(AUTH_OUTCOMES).toEqual([
      'authorized',
      'denied',
      'rate_limited',
      'transient',
      'invalid',
    ])
    expect(AUTH_OUTCOME_REASONS).toEqual([
      'cookie',
      'device_pair',
      'local_rate_limit',
      'provider_rate_limit',
      'not_configured',
      'invalid_request',
      'identity_token_invalid',
      'provider_unavailable',
      'server_error',
      'no_invite',
      'verification_failed',
      'access_revoked',
      'setup_claim_denied',
    ])
    expect(AUTH_OUTCOME_SCOPES).toEqual([
      'global',
      'trusted_client',
      'pin',
      'identity',
      'upstream',
    ])
  })

  it('emits a rounded, redacted event at most once per request', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValue(1_149)

    const app = new Hono()
    app.use('*', requestId())
    app.post('/login', async (c) => {
      const outcome = createAuthOutcomeReporter(c, 'apple', 'identity_verify')
      outcome.record('authorized', 'cookie')
      outcome.record('denied', 'no_invite')
      return c.json({ ok: true })
    })

    const response = await app.request('/login', {
      method: 'POST',
      headers: {
        'X-Request-Id': 'auth-outcome-request',
        Authorization: 'Bearer TOKEN-SENTINEL',
        Cookie: 'eex.session=COOKIE-SENTINEL',
      },
      body: JSON.stringify({
        sub: 'SUB-SENTINEL',
        email: 'EMAIL-SENTINEL',
        pinId: 'PIN-SENTINEL',
        inviteCode: 'INVITE-SENTINEL',
        challengeId: 'CHALLENGE-SENTINEL',
        response: 'ASSERTION-SENTINEL',
      }),
    })

    expect(response.status).toBe(200)
    const lines = [...info.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .filter((line) => line.startsWith('[auth-outcome] '))
    expect(lines).toHaveLength(1)
    const context = JSON.parse(lines[0].slice(lines[0].indexOf('{'))) as Record<string, unknown>
    expect(context).toEqual({
      event: 'auth_outcome',
      provider: 'apple',
      phase: 'identity_verify',
      outcome: 'authorized',
      reason: 'cookie',
      elapsedMs: 100,
      requestId: 'auth-outcome-request',
    })
    expect(context.elapsedMs).toBeTypeOf('number')
    expect((context.elapsedMs as number) % 100).toBe(0)
    for (const sentinel of [
      'TOKEN-SENTINEL',
      'COOKIE-SENTINEL',
      'SUB-SENTINEL',
      'EMAIL-SENTINEL',
      'PIN-SENTINEL',
      'INVITE-SENTINEL',
      'CHALLENGE-SENTINEL',
      'ASSERTION-SENTINEL',
    ]) {
      expect(lines[0]).not.toContain(sentinel)
    }
  })

  it('records one bounded transient event when a route throws unexpectedly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = new Hono()
    app.use('*', requestId())
    app.get('/login', (c) =>
      withAuthOutcome(c, 'google', 'identity_verify', async () => {
        throw new Error('VERIFIER-ERROR-SENTINEL')
      }),
    )

    const response = await app.request('/login', {
      headers: { 'X-Request-Id': 'unexpected-auth-failure' },
    })

    expect(response.status).toBe(500)
    const lines = warn.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.startsWith('[auth-outcome] '))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0].slice(lines[0].indexOf('{')))).toEqual(
      expect.objectContaining({
        event: 'auth_outcome',
        provider: 'google',
        phase: 'identity_verify',
        outcome: 'transient',
        reason: 'server_error',
        requestId: 'unexpected-auth-failure',
      }),
    )
    expect(lines[0]).not.toContain('VERIFIER-ERROR-SENTINEL')
    error.mockRestore()
  })
})
