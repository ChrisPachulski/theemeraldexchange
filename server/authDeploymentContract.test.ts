import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function composeHas(source: string, key: string): boolean {
  return new RegExp(`^\\s+${key}:`, 'm').test(source)
}

function exampleHas(source: string, key: string): boolean {
  return new RegExp(`^#?\\s*${key}=`, 'm').test(source)
}

describe('auth deployment configuration contract', () => {
  const surfaces = [
    {
      name: 'owner deployment',
      compose: read('docker-compose.yml'),
      example: read('.env.example'),
    },
    {
      name: 'published self-host deployment',
      compose: read('selfhost/docker-compose.yml'),
      example: read('selfhost/.env.example'),
    },
  ]

  const sharedKeys = [
    'ADMINS',
    'ADMIN_SUBS',
    'APPLE_CLIENT_ID',
    'ENABLE_APPLE_SIGN_IN',
    'GOOGLE_CLIENT_ID',
    'ENABLE_GOOGLE_SIGN_IN',
    'WEBAUTHN_RP_ID',
    'WEBAUTHN_RP_NAME',
    'WEBAUTHN_ORIGINS',
    'PLEX_CLIENT_ID',
    'PLEX_SERVER_ID',
  ]

  it.each(surfaces)('$name passes every supported provider/authz input into the backend', ({ compose }) => {
    expect(
      sharedKeys.filter((key) => !composeHas(compose, key)),
      'auth inputs missing from backend.environment',
    ).toEqual([])
  })

  it.each(surfaces)('$name documents every supported provider/authz input', ({ example }) => {
    expect(
      sharedKeys.filter((key) => !exampleHas(example, key)),
      'auth inputs missing from env example',
    ).toEqual([])
  })
})
