// 2026-10-16 review item 12: selfhost/install.sh and scripts/self-host-env.sh
// chmod .env to 0600, then replace it with `grep ... > .env.tmp && mv`, which
// leaves the secrets file at the umask default (0644, world-readable).
//
// Lives under server/ so vitest's `server/**/*.test.ts` include picks it up.

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'selfhost-perms-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8)
// The empty placeholder is what triggers the grep > .env.tmp && mv rewrite.
const PLACEHOLDER_ENV = 'SESSION_SECRET=\nMEDIA_PATH=/srv/media\n'

describe('self-host secrets file permissions', () => {
  it('self-host-env.sh leaves .env at 0600 after rewriting a placeholder', () => {
    const d = scratch()
    writeFileSync(join(d, '.env'), PLACEHOLDER_ENV)
    execFileSync('sh', ['-c', `umask 022; sh "${join(repo, 'scripts/self-host-env.sh')}" "${join(d, '.env')}"`])
    expect(mode(join(d, '.env'))).toBe('600')
  })

  it('install.sh leaves .env at 0600 after rewriting a placeholder', () => {
    const d = scratch()
    for (const f of ['docker-compose.yml', 'tailscale-serve.json', '.env.example']) writeFileSync(join(d, f), '')
    writeFileSync(join(d, '.env'), PLACEHOLDER_ENV)
    const bin = scratch()
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'docker'), 0o755)
    execFileSync('sh', ['-c', `umask 022; sh "${join(repo, 'selfhost/install.sh')}"`], {
      cwd: d,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    expect(mode(join(d, '.env'))).toBe('600')
  })
})
