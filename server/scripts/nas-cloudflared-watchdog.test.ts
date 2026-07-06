// Shell-out test for scripts/nas-cloudflared-watchdog.sh — the cron watchdog
// that self-heals the Cloudflare Tunnel after a standalone backend restart
// (the stale-netns 1033/530 outage). The repo has no bats harness, so per the
// campaign brief this drives the script's built-in `--self-test`, `--compare`,
// and `--dry-run` modes from vitest (which shells out elsewhere too — see
// ffmpeg.test.ts / iptvRemux.test.ts).
//
// Lives under server/ so vitest's `server/**/*.test.ts` include picks it up;
// it imports no server source, so it does not move coverage.
//
// RED on origin/main (the script does not exist -> spawn ENOENT), GREEN here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '../../scripts/nas-cloudflared-watchdog.sh')

/** Run the watchdog with args; return {status, stdout} without throwing. */
function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; message?: string }
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: (e.stdout ?? '').toString(),
    }
  }
}

/** Write a fake `docker` onto a temp dir that returns canned StartedAt values. */
function fakeDockerDir(backendStartedAt: string, cloudflaredStartedAt: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfwd-'))
  const script = `#!/usr/bin/env bash
if [[ "$1" == "inspect" ]]; then
  case "$4" in
    exchange-backend)     echo "${backendStartedAt}" ;;
    exchange-cloudflared) echo "${cloudflaredStartedAt}" ;;
  esac
  exit 0
fi
exit 0
`
  const p = join(dir, 'docker')
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return dir
}

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('nas-cloudflared-watchdog.sh', () => {
  beforeAll(() => {
    // Clear red→green signal: on origin/main this file is absent.
    expect(existsSync(SCRIPT), `watchdog script missing at ${SCRIPT}`).toBe(true)
  })

  it('--self-test passes every comparison check', () => {
    const { status, stdout } = run(['--self-test'])
    expect(stdout).toMatch(/ALL \d+ CHECKS PASSED/)
    expect(stdout).not.toMatch(/FAIL/)
    expect(status).toBe(0)
  })

  describe('--compare decides recreate vs skip', () => {
    const cases: Array<[string, string, string, 'RECREATE' | 'SKIP']> = [
      ['backend newer than cloudflared', '2026-07-06T15:49:10Z', '2026-07-06T10:00:00Z', 'RECREATE'],
      ['cloudflared newer than backend', '2026-07-06T10:00:00Z', '2026-07-06T15:49:10Z', 'SKIP'],
      ['identical -> not strictly newer', '2026-07-06T15:49:10Z', '2026-07-06T15:49:10Z', 'SKIP'],
      // The variable-length-fraction trap: Go's RFC3339Nano trims trailing
      // zeros, so a naive string compare says ".5Z" > ".500000005Z" (because
      // 'Z' > '0') and would recreate spuriously. The normalizer must not.
      ['trimmed fraction .5 is OLDER than .500000005', '2026-07-06T15:49:10.5Z', '2026-07-06T15:49:10.500000005Z', 'SKIP'],
      ['trimmed fraction .6 is NEWER than .500000005', '2026-07-06T15:49:10.6Z', '2026-07-06T15:49:10.500000005Z', 'RECREATE'],
      ['docker zero-time cloudflared (never started)', '2026-07-06T15:49:10Z', '0001-01-01T00:00:00Z', 'RECREATE'],
    ]
    for (const [name, backend, cf, expected] of cases) {
      it(name, () => {
        const { status, stdout } = run(['--compare', backend, cf])
        expect(status).toBe(0)
        expect(stdout.trim()).toBe(expected)
      })
    }
  })

  it('--dry-run detects drift and logs the recreate it WOULD run, without touching docker', () => {
    // backend started 5h after cloudflared -> stale netns -> would recreate.
    const dir = fakeDockerDir('2026-07-06T15:49:10.000000000Z', '2026-07-06T10:00:00.000000000Z')
    tmpDirs.push(dir)
    const { status, stdout } = run(['--dry-run'], { DOCKER_BIN: join(dir, 'docker') })
    expect(status).toBe(0)
    expect(stdout).toMatch(/DRIFT:/)
    expect(stdout).toMatch(/\[dry-run\] would run:.*--force-recreate cloudflared/)
  })

  it('--dry-run takes no action when cloudflared is newer than backend', () => {
    const dir = fakeDockerDir('2026-07-06T10:00:00Z', '2026-07-06T15:49:10Z')
    tmpDirs.push(dir)
    const { status, stdout } = run(['--dry-run'], { DOCKER_BIN: join(dir, 'docker') })
    expect(status).toBe(0)
    expect(stdout).toMatch(/OK:.*no action/)
    expect(stdout).not.toMatch(/DRIFT|would run/)
  })

  it('rejects unknown arguments with a usage exit code', () => {
    const { status } = run(['--bogus'])
    expect(status).toBe(64)
  })
})
