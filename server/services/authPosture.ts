export type AuthPostureConfig = {
  plexClientId: string | null
  appleClientId: string | null
  googleClientIds: readonly string[]
  workosClientId: string | null
  serveSpa: boolean
  isProd: boolean
  trustClientIpHeaders: boolean
  allowedOrigins: readonly string[]
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin === 'null' ||
      value !== url.origin
    ) {
      return 'invalid_origin'
    }
    return url.origin
  } catch {
    return 'invalid_origin'
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
      workos: Boolean(config.workosClientId),
    },
    serveSpa: config.serveSpa,
    trustedClientIpHeaders: config.trustClientIpHeaders,
    sessionCookieSameSite: config.serveSpa || !config.isProd ? 'lax' : 'none',
    allowedOrigins: config.allowedOrigins.map(safeOrigin),
  } as const
}
