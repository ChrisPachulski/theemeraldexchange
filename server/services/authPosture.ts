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
    return new URL(value).origin
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
      passkey: true,
    },
    serveSpa: config.serveSpa,
    trustedClientIpHeaders: config.trustClientIpHeaders,
    sessionCookieSameSite: config.serveSpa ? 'lax' : 'none',
    allowedOrigins: config.allowedOrigins.map(safeOrigin),
    webauthnRpId: config.webauthnRpId,
    webauthnOrigins: config.webauthnOrigins.map(safeOrigin),
  } as const
}
