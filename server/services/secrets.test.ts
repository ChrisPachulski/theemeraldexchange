import { describe, it, expect } from 'vitest'
import {
  validateSecretStrength,
  assertSecretsDistinct,
  SECRET_MIN_LEN,
} from './secrets.js'

const STRONG = 'this-is-a-strong-secret-that-is-32-chars-long'

describe('validateSecretStrength', () => {
  it('passes a strong secret in prod', () => {
    expect(() => validateSecretStrength('TEST_SECRET', STRONG, true)).not.toThrow()
  })

  it('is a no-op outside prod regardless of value', () => {
    expect(() => validateSecretStrength('TEST_SECRET', 'short', false)).not.toThrow()
    expect(() => validateSecretStrength('TEST_SECRET', 'changeme', false)).not.toThrow()
  })

  it('rejects placeholder strings in prod (case-insensitive)', () => {
    expect(() => validateSecretStrength('S', 'changeme', true)).toThrow(/placeholder/)
    expect(() => validateSecretStrength('S', 'CHANGEME', true)).toThrow(/placeholder/)
    expect(() => validateSecretStrength('S', 'secret', true)).toThrow(/placeholder/)
    expect(() => validateSecretStrength('S', 'password', true)).toThrow(/placeholder/)
  })

  it(`rejects secrets shorter than ${SECRET_MIN_LEN} chars in prod`, () => {
    const short = 'a'.repeat(SECRET_MIN_LEN - 1)
    expect(() => validateSecretStrength('S', short, true)).toThrow(/too short/)
  })

  it('accepts a secret exactly at the minimum length in prod', () => {
    const atMin = 'a'.repeat(SECRET_MIN_LEN)
    expect(() => validateSecretStrength('S', atMin, true)).not.toThrow()
  })
})

describe('assertSecretsDistinct', () => {
  const A = 'aaaa-secret-0123456789abcdef0123'
  const B = 'bbbb-secret-0123456789abcdef0123'
  const C = 'cccc-secret-0123456789abcdef0123'

  it('passes when all three secrets are distinct', () => {
    expect(() =>
      assertSecretsDistinct({
        SESSION_SECRET: A,
        STREAM_TOKEN_SECRET: B,
        DEVICE_TOKEN_SECRET: C,
      }),
    ).not.toThrow()
  })

  it('passes when DEVICE_TOKEN_SECRET is absent (D13 not yet deployed)', () => {
    expect(() =>
      assertSecretsDistinct({
        SESSION_SECRET: A,
        STREAM_TOKEN_SECRET: B,
      }),
    ).not.toThrow()
  })

  it('throws when SESSION_SECRET === STREAM_TOKEN_SECRET', () => {
    expect(() =>
      assertSecretsDistinct({
        SESSION_SECRET: A,
        STREAM_TOKEN_SECRET: A,
      }),
    ).toThrow(/FATAL.*SESSION_SECRET.*STREAM_TOKEN_SECRET/)
  })

  it('throws when SESSION_SECRET === DEVICE_TOKEN_SECRET', () => {
    expect(() =>
      assertSecretsDistinct({
        SESSION_SECRET: A,
        STREAM_TOKEN_SECRET: B,
        DEVICE_TOKEN_SECRET: A,
      }),
    ).toThrow(/FATAL.*SESSION_SECRET.*DEVICE_TOKEN_SECRET/)
  })

  it('throws when STREAM_TOKEN_SECRET === DEVICE_TOKEN_SECRET', () => {
    expect(() =>
      assertSecretsDistinct({
        SESSION_SECRET: A,
        STREAM_TOKEN_SECRET: B,
        DEVICE_TOKEN_SECRET: B,
      }),
    ).toThrow(/FATAL.*STREAM_TOKEN_SECRET.*DEVICE_TOKEN_SECRET/)
  })

  it('skips the DEVICE_TOKEN_SECRET pair when the value is null', () => {
    expect(() =>
      assertSecretsDistinct({
        SESSION_SECRET: A,
        STREAM_TOKEN_SECRET: B,
        DEVICE_TOKEN_SECRET: null,
      }),
    ).not.toThrow()
  })
})
