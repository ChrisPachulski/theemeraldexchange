import { describe, expect, it } from 'vitest'
import { buildAuthPosture } from './authPosture.js'

describe('buildAuthPosture', () => {
  it('reports only public auth configuration and deployment booleans', () => {
    const posture = buildAuthPosture({
      plexClientId: 'public-plex-client-id',
      appleClientId: 'com.example.web',
      googleClientIds: ['public-google-client-id'],
      serveSpa: false,
      isProd: true,
      trustClientIpHeaders: true,
      allowedOrigins: ['https://app.example.test'],
      webauthnRpId: 'example.test',
      webauthnRpIdExplicit: true,
      webauthnOrigins: ['https://app.example.test'],
    })

    expect(posture).toEqual({
      event: 'auth_posture',
      providers: { plex: true, apple: true, google: true, passkey: true },
      serveSpa: false,
      trustedClientIpHeaders: true,
      sessionCookieSameSite: 'none',
      allowedOrigins: ['https://app.example.test'],
      webauthnRpMode: 'configured',
      webauthnRpId: 'example.test',
      webauthnOrigins: ['https://app.example.test'],
    })
    expect(JSON.stringify(posture)).not.toContain('client-id')
  })

  it('describes a same-origin passkey-only install without inventing secrets', () => {
    expect(
      buildAuthPosture({
        plexClientId: null,
        appleClientId: null,
        googleClientIds: [],
        serveSpa: true,
        isProd: true,
        trustClientIpHeaders: false,
        allowedOrigins: [],
        webauthnRpId: 'fallback-secret.example',
        webauthnRpIdExplicit: false,
        webauthnOrigins: ['https://fallback-secret.example'],
      }),
    ).toMatchObject({
      providers: { plex: false, apple: false, google: false, passkey: true },
      sessionCookieSameSite: 'lax',
      allowedOrigins: [],
      webauthnRpMode: 'request-derived',
      webauthnRpId: 'request_host',
      webauthnOrigins: ['request_origin'],
    })
    expect(
      JSON.stringify(
        buildAuthPosture({
          plexClientId: null,
          appleClientId: null,
          googleClientIds: [],
          serveSpa: true,
          isProd: true,
          trustClientIpHeaders: false,
          allowedOrigins: [],
          webauthnRpId: 'fallback-secret.example',
          webauthnRpIdExplicit: false,
          webauthnOrigins: ['https://fallback-secret.example'],
        }),
      ),
    ).not.toContain('fallback-secret')
  })

  it('reports the actual Lax cookie posture for split-origin development', () => {
    expect(
      buildAuthPosture({
        plexClientId: null,
        appleClientId: null,
        googleClientIds: [],
        serveSpa: false,
        isProd: false,
        trustClientIpHeaders: false,
        allowedOrigins: [],
        webauthnRpId: 'localhost',
        webauthnRpIdExplicit: true,
        webauthnOrigins: ['http://localhost:5173'],
      }).sessionCookieSameSite,
    ).toBe('lax')
  })

  it('never copies URL credentials, paths, or a hostile RP id into the boot log', () => {
    const posture = buildAuthPosture({
      plexClientId: null,
      appleClientId: null,
      googleClientIds: [],
      serveSpa: false,
      isProd: true,
      trustClientIpHeaders: false,
      allowedOrigins: [
        'https://operator:secret@app.example.test/private',
        'https://trailing-slash.example.test/',
      ],
      webauthnRpId: 'https://owner:rp-secret@app.example.test/private',
      webauthnRpIdExplicit: true,
      webauthnOrigins: ['not a valid origin', 'javascript:origin-secret'],
    })

    expect(posture.allowedOrigins).toEqual(['invalid_origin', 'invalid_origin'])
    expect(posture.webauthnRpId).toBe('invalid_rp_id')
    expect(posture.webauthnOrigins).toEqual(['invalid_origin', 'invalid_origin'])
    expect(JSON.stringify(posture)).not.toContain('operator')
    expect(JSON.stringify(posture)).not.toContain('secret')
    expect(JSON.stringify(posture)).not.toContain('private')
    expect(JSON.stringify(posture)).not.toContain('rp-secret')
    expect(JSON.stringify(posture)).not.toContain('origin-secret')
  })
})
