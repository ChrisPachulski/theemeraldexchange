export type AuthPostureConfig = {
  plexClientId: string | null
  appleClientId: string | null
  googleClientIds: readonly string[]
  serveSpa: boolean
  trustClientIpHeaders: boolean
  allowedOrigins: readonly string[]
  webauthnRpId: string
  webauthnOrigins: readonly string[]
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === 'null') {
      return 'invalid_origin'
    }
    return url.origin
  } catch {
    return 'invalid_origin'
  }
}

function safeRpId(value: string): string {
  const candidate = value.trim().toLowerCase()
  if (
    candidate.length === 0 ||
    candidate.length > 253 ||
    candidate.includes('/') ||
    candidate.includes('@') ||
    candidate.includes(':') ||
    candidate.includes('?') ||
    candidate.includes('#')
  ) {
    return 'invalid_rp_id'
  }

  try {
    const url = new URL(`https://${candidate}`)
    return url.hostname === candidate ? url.hostname : 'invalid_rp_id'
  } catch {
    return 'invalid_rp_id'
  }
}

/** Public, secret-free authentication posture suitable for one boot log row. */
export function buildAuthPosture(config: AuthPostureConfig) {
  return {
    event: 'auth_posture',
    providers: {
      plex: Boolean(config.plexClientId),
      apple: Boolean(config.appleClientId),
      google: config.googleClientIds.length > 0,
      passkey: true,
    },
    serveSpa: config.serveSpa,
    trustedClientIpHeaders: config.trustClientIpHeaders,
    sessionCookieSameSite: config.serveSpa ? 'lax' : 'none',
    allowedOrigins: config.allowedOrigins.map(safeOrigin),
    webauthnRpId: safeRpId(config.webauthnRpId),
    webauthnOrigins: config.webauthnOrigins.map(safeOrigin),
  } as const
}
