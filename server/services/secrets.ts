// Shared helpers for secret validation and boot-time distinctness checks.
//
// Used by server/env.ts to enforce:
//   - minimum length (≥32 chars)
//   - rejection of known placeholder strings
//   - pairwise distinctness across SESSION_SECRET, STREAM_TOKEN_SECRET,
//     and DEVICE_TOKEN_SECRET (contract §3.1 / §5.4)
//
// Also the canonical constant-time string compare used by the auth nonce
// checks (apple/google) and the invite-code-hash check.

import { timingSafeEqual } from 'node:crypto'

// Constant-time string compare. Returns false on length mismatch — the early
// return is not itself constant-time w.r.t. length, but timingSafeEqual
// REQUIRES equal-length buffers (comparing unequal lengths throws). For the
// hex digests / nonces this guards, byte length equals string length.
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const SECRET_MIN_LEN = 32

export const SECRET_PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'secret',
  'password',
  'test',
  'test-secret',
  'replaceme',
  'replace-me',
  'replace_me',
  'your-secret-here',
  'session-secret',
])

/**
 * Validates that a secret meets production-strength requirements:
 *   - not a known placeholder string (case-insensitive)
 *   - at least SECRET_MIN_LEN characters
 *
 * Only enforces in production (call-site passes `isProd`).
 */
export function validateSecretStrength(
  name: string,
  value: string,
  isProd: boolean,
): void {
  if (!isProd) return
  if (SECRET_PLACEHOLDERS.has(value.toLowerCase())) {
    throw new Error(
      `${name} looks like a placeholder value. ` +
        'Generate a real secret with `openssl rand -base64 48` and ' +
        'redeploy — leaving the placeholder in prod defeats key separation.',
    )
  }
  if (value.length < SECRET_MIN_LEN) {
    throw new Error(
      `${name} is too short for production (${value.length} chars). ` +
        `Use at least ${SECRET_MIN_LEN} bytes — generate one with ` +
        '`openssl rand -base64 48`.',
    )
  }
}

/**
 * Boot-time assertion: the three top-level secrets must be pairwise
 * distinct at all times (production and development alike).  A shared
 * value defeats the key-separation goal that justifies having three
 * distinct env vars in the first place.
 *
 * Pairs involving an undefined/empty secret are skipped — a key that
 * does not exist yet cannot be checked.  As each new secret is
 * introduced (D13 adds DEVICE_TOKEN_SECRET) the full check becomes
 * active automatically.
 *
 * Contract §3.1 / §5.4:
 *   FATAL: <A> and <B> must be different values.
 *   Shared secrets defeat key-separation. Set distinct secrets in your
 *   .env.local and redeploy — do not reuse SESSION_SECRET.
 */
export function assertSecretsDistinct(secrets: {
  SESSION_SECRET: string
  STREAM_TOKEN_SECRET: string
  DEVICE_TOKEN_SECRET?: string | null
  INTERNAL_PRINCIPAL_SECRET?: string | null
}): void {
  const candidates: Array<[string, string]> = [
    ['SESSION_SECRET', secrets.SESSION_SECRET],
    ['STREAM_TOKEN_SECRET', secrets.STREAM_TOKEN_SECRET],
  ]
  if (secrets.DEVICE_TOKEN_SECRET) {
    candidates.push(['DEVICE_TOKEN_SECRET', secrets.DEVICE_TOKEN_SECRET])
  }
  if (secrets.INTERNAL_PRINCIPAL_SECRET) {
    candidates.push(['INTERNAL_PRINCIPAL_SECRET', secrets.INTERNAL_PRINCIPAL_SECRET])
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const [nameA, valA] = candidates[i]
      const [nameB, valB] = candidates[j]
      if (valA === valB) {
        throw new Error(
          `FATAL: ${nameA} and ${nameB} must be different values. ` +
            'Shared secrets defeat key-separation. Set distinct secrets in your ' +
            '.env.local and redeploy — do not reuse SESSION_SECRET.',
        )
      }
    }
  }
}
