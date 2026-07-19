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
  const nextService = lines.findIndex(
    (line, index) =>
      index > backendStart && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line),
  )
  const backend = lines.slice(backendStart + 1, nextService === -1 ? undefined : nextService)

  const environmentStart = backend.findIndex((line) => /^ {4}environment:\s*$/.test(line))
  if (environmentStart === -1) return ''

  const environmentEnd = backend.findIndex(
    (line, index) => index > environmentStart && /^ {4}\S/.test(line),
  )
  return backend
    .slice(environmentStart + 1, environmentEnd === -1 ? undefined : environmentEnd)
    .join('\n')
}

function composeHas(source: string, key: string): boolean {
  return new RegExp(
    `^\\s{6}${key}:\\s*["']?\\$\\{${key}(?::-[^}]*)?\\}["']?\\s*$`,
    'm',
  ).test(backendEnvironment(source))
}

function exampleHas(source: string, key: string): boolean {
  return new RegExp(`^#?\\s*${key}=`, 'm').test(source)
}

describe('auth deployment configuration contract', () => {
  const deployScript = read('scripts/deploy-nas.sh')
  const surfaces = [
    {
      name: 'owner deployment',
      compose: read('docker-compose.yml'),
      example: read('.env.production.example'),
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

  it('requires backend.environment to exist before accepting a later service input', () => {
    expect(
      composeHas(
        [
          'services:',
          '  backend:',
          '    image: backend',
          '  worker:',
          '    environment:',
          '      SIBLING_ONLY: "${SIBLING_ONLY:-}"',
        ].join('\n'),
        'SIBLING_ONLY',
      ),
    ).toBe(false)
  })

  it('rejects a hardcoded backend value that does not pass through the named input', () => {
    expect(
      composeHas(
        [
          'services:',
          '  backend:',
          '    environment:',
          '      AUTH_INPUT: hardcoded',
        ].join('\n'),
        'AUTH_INPUT',
      ),
    ).toBe(false)
  })

  it('keeps the NAS preflight boot-only when Plex has no server id', () => {
    expect(deployScript).toContain('plex_client_id_value=$(env_value PLEX_CLIENT_ID')
    expect(deployScript).toContain('if [[ -z "$plex_client_id_value" ]]')
    expect(deployScript).toContain('This permits boot only')
    expect(deployScript).not.toMatch(/ANY Plex|open mode/)
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
