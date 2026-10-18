// 2026-10-16 review item 32: on a fresh box Docker creates a missing bind-mount
// source as root:root. The backend runs as uid 10001 but its data dir was never
// chowned, and the transcoder scratch dir the compose says "the deploy
// provisions" was never created, so both services failed on a fresh deploy.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const deploy = readFileSync(resolve(ROOT, 'scripts/deploy-nas.sh'), 'utf8')

describe('deploy-nas.sh provisions every bind-mount a non-root service writes', () => {
  it('chowns the backend data dir to the uid the backend image runs as', () => {
    const uid = /useradd [^\n]*--uid (\d+)[^\n]* emerald/.exec(readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8'))?.[1]
    expect(uid).toBeDefined()
    expect(deploy).toContain(`chown ${uid}:${uid} \${APPDATA}/data`)
  })

  it('creates the transcoder scratch dir world-writable and sticky', () => {
    expect(deploy).toMatch(/mkdir -p [^\n]*'\$\{scratch_dir\}'/)
    expect(deploy).toContain(`chmod 1777 '\${scratch_dir}'`)
    expect(readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf8')).toContain(
      '${TRANSCODER_SCRATCH_HOST_PATH:-/mnt/user/appdata/exchange-backend/transcoder-scratch}:/scratch',
    )
  })
})
