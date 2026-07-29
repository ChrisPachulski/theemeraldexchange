import type { Context } from 'hono'
import { createLogger } from './logger.js'

export const AUTH_OUTCOME_PROVIDERS = ['plex', 'apple', 'google', 'passkey'] as const
export const AUTH_OUTCOME_PHASES = [
  'check',
  'identity_verify',
  'login_options',
  'login_verify',
  'register_options',
  'register_verify',
] as const
export const AUTH_OUTCOMES = [
  'authorized',
  'denied',
  'rate_limited',
  'transient',
  'invalid',
] as const
export const AUTH_OUTCOME_REASONS = [
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
] as const
export const AUTH_OUTCOME_SCOPES = [
  'global',
  'trusted_client',
  'pin',
  'identity',
  'upstream',
] as const

export type AuthOutcomeProvider = (typeof AUTH_OUTCOME_PROVIDERS)[number]
export type AuthOutcomePhase = (typeof AUTH_OUTCOME_PHASES)[number]
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number]
export type AuthOutcomeReason = (typeof AUTH_OUTCOME_REASONS)[number]
export type AuthOutcomeScope = (typeof AUTH_OUTCOME_SCOPES)[number]

export type AuthOutcomeMeta = {
  scope?: AuthOutcomeScope
  retryAfterSeconds?: number
}

export type AuthOutcomeReporter = {
  record(outcome: AuthOutcome, reason: AuthOutcomeReason, meta?: AuthOutcomeMeta): boolean
}

const log = createLogger('auth-outcome')
const ELAPSED_ROUNDING_MS = 100

export function createAuthOutcomeReporter(
  c: Context,
  provider: AuthOutcomeProvider,
  phase: AuthOutcomePhase,
): AuthOutcomeReporter {
  const startedAt = Date.now()
  const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? 'unavailable'
  let recorded = false

  return {
    record(outcome, reason, meta) {
      if (recorded) return false
      recorded = true
      const elapsedMs =
        Math.round(Math.max(0, Date.now() - startedAt) / ELAPSED_ROUNDING_MS) *
        ELAPSED_ROUNDING_MS
      const context = {
        event: 'auth_outcome',
        provider,
        phase,
        outcome,
        reason,
        ...(meta?.scope ? { scope: meta.scope } : {}),
        ...(meta?.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: meta.retryAfterSeconds }
          : {}),
        elapsedMs,
        requestId,
      }
      if (outcome === 'authorized') {
        log.info('terminal', context)
      } else {
        log.warn('terminal', context)
      }
      return true
    },
  }
}

export async function withAuthOutcome<T>(
  c: Context,
  provider: AuthOutcomeProvider,
  phase: AuthOutcomePhase,
  run: (outcome: AuthOutcomeReporter) => Promise<T> | T,
): Promise<T> {
  const outcome = createAuthOutcomeReporter(c, provider, phase)
  try {
    return await run(outcome)
  } catch (error) {
    outcome.record('transient', 'server_error')
    throw error
  }
}
