import { describe, expect, it } from 'vitest'
import { buildAuthPosture } from './authPosture.js'

describe('buildAuthPosture', () => {
  it('reports only public auth configuration and deployment booleans', () => {
    const posture = buildAuthPosture({
      plexClientId: 'public-plex-client-id',
      appleClientId: 'com.example.web',
      googleClientIds: ['public-google-client-id'],
      workosClientId: null,
      serveSpa: false,
      isProd: true,
      trustClientIpHeaders: true,
      allowedOrigins: ['https://app.example.test'],
    })

    expect(posture).toEqual({
      event: 'auth_posture',
      providers: { plex: true, apple: true, google: true, workos: false },
      serveSpa: false,
      trustedClientIpHeaders: true,
      sessionCookieSameSite: 'none',
      allowedOrigins: ['https://app.example.test'],
    })
    expect(JSON.stringify(posture)).not.toContain('client-id')
  })

  it('reports the actual Lax cookie posture for same-origin and development installs', () => {
    const base = {
      plexClientId: null,
      appleClientId: null,
      googleClientIds: [],
      workosClientId: 'client_public',
      trustClientIpHeaders: false,
      allowedOrigins: [],
    }
    expect(buildAuthPosture({ ...base, serveSpa: true, isProd: true })).toMatchObject({
      providers: { plex: false, apple: false, google: false, workos: true },
      sessionCookieSameSite: 'lax',
    })
    expect(buildAuthPosture({ ...base, serveSpa: false, isProd: false }).sessionCookieSameSite).toBe(
      'lax',
    )
  })

  it('never copies URL credentials or paths into the boot log', () => {
    const posture = buildAuthPosture({
      plexClientId: null,
      appleClientId: null,
      googleClientIds: [],
      workosClientId: null,
      serveSpa: false,
      isProd: true,
      trustClientIpHeaders: false,
      allowedOrigins: [
        'https://operator:secret@app.example.test/private',
        'https://trailing-slash.example.test/',
      ],
    })

    expect(posture.allowedOrigins).toEqual(['invalid_origin', 'invalid_origin'])
    expect(JSON.stringify(posture)).not.toContain('operator')
    expect(JSON.stringify(posture)).not.toContain('secret')
    expect(JSON.stringify(posture)).not.toContain('private')
  })
})
