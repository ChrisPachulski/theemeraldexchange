// Shell-out test for scripts/ci-gate.sh — the deploy gate that refuses to ship
// a commit GitHub Actions has not passed. A local HTTP server plays the
// check-runs API so the verdicts (pass / fail / cancelled / pending / none /
// bypass) are exercised without a network. Same pattern as
// nas-cloudflared-watchdog.test.ts: lives under server/ for vitest's include.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '../../scripts/ci-gate.sh')

let server: Server
let port = 0
let body = '{"check_runs":[]}'
let lastPath = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? ''
    res.setHeader('content-type', 'application/json')
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())

function checkRuns(runs: Array<{ name: string; status: string; conclusion: string | null }>) {
  body = JSON.stringify({ total_count: runs.length, check_runs: runs })
}

/**
 * Spawn the gate asynchronously: a sync spawn would block the event loop and
 * the in-process fake API could never answer curl (deadlock).
 */
function run(env: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(
      'bash',
      [SCRIPT, 'abc1234def'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          EEX_GITHUB_REPO: 'o/r',
          CI_GATE_POLL_SECS: '0',
          CI_GATE_WAIT_SECS: '1',
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const status = err ? ((err as { code?: number }).code ?? 1) : 0
        resolveRun({ status, stdout, stderr })
      },
    )
  })
}

const ok = (name: string) => ({ name, status: 'completed', conclusion: 'success' })

describe('scripts/ci-gate.sh', () => {
  it('passes when every check on the sha succeeded, querying the right repo and sha', async () => {
    checkRuns([ok('test'), ok('rust')])
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('2 checks passed')
    expect(lastPath).toBe('/repos/o/r/commits/abc1234def/check-runs?per_page=100')
  })

  it('treats skipped and neutral conclusions as passing', async () => {
    checkRuns([ok('test'), { name: 'docs', status: 'completed', conclusion: 'skipped' }, { name: 'lint', status: 'completed', conclusion: 'neutral' }])
    expect((await run()).status).toBe(0)
  })

  it('fails naming the red check', async () => {
    checkRuns([ok('test'), { name: 'rust', status: 'completed', conclusion: 'failure' }])
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('rust (failure)')
  })

  it('treats a cancelled check as red (the sha was superseded)', async () => {
    checkRuns([{ name: 'rust', status: 'completed', conclusion: 'cancelled' }])
    expect((await run()).status).toBe(1)
  })

  it('exits 2 when checks are still running past the wait budget', async () => {
    checkRuns([ok('test'), { name: 'rust', status: 'in_progress', conclusion: null }])
    const r = await run()
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('still pending')
  })

  it('exits 2 and says so when the sha has no checks at all (never pushed)', async () => {
    checkRuns([])
    const r = await run()
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('never pushed')
  })

  it('SKIP_CI_GATE=1 bypasses a red verdict loudly', async () => {
    checkRuns([{ name: 'rust', status: 'completed', conclusion: 'failure' }])
    const r = await run({ SKIP_CI_GATE: '1' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('SKIP_CI_GATE')
  })
})
