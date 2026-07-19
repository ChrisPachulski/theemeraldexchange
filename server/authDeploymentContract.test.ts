import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function backendEnvironment(source: string): string {
  const lines = source.split('\n')
  const backendStart = lines.findIndex((line) => /^ {2}backend:\s*$/.test(line))
  if (backendStart === -1) return ''

  const environmentStart = lines.findIndex(
    (line, index) => index > backendStart && /^ {4}environment:\s*$/.test(line),
  )
  if (environmentStart === -1) return ''

  const environmentEnd = lines.findIndex(
    (line, index) => index > environmentStart && /^ {4}\S/.test(line),
  )
  return lines
    .slice(environmentStart + 1, environmentEnd === -1 ? undefined : environmentEnd)
    .join('\n')
}

function composeHas(source: string, key: string): boolean {
  return new RegExp(`^\\s{6}${key}:`, 'm').test(backendEnvironment(source))
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
    'ALLOW_UNSCOPED_PLEX_LOGIN',
  ]

  it('does not mistake a sibling service variable for a backend input', () => {
    expect(
      composeHas(
        [
          'services:',
          '  backend:',
          '    environment:',
          '      PRESENT: value',
          '  worker:',
          '    environment:',
          '      SIBLING_ONLY: value',
        ].join('\n'),
        'SIBLING_ONLY',
      ),
    ).toBe(false)
  })

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
