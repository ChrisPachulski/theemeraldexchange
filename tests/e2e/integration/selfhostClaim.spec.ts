import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Plan 006 Phase 6 — the self-host smoke, end to end and UNMOCKED:
// a bare production backend (no Plex, no *arr, no IPTV, no telemetry, no
// ALLOWED_ORIGINS) serving the real built SPA same-origin, claimed through
// the real browser UI with a REAL WebAuthn ceremony (CDP virtual
// authenticator), then proving normal login stays fail closed and the owner can
// mint invites. This is the "a stranger can run one" acceptance test.
//
// Spawns its OWN server (the shared integrationServer is a claimed,
// arr-configured install — the opposite posture). http://localhost is a
// secure context, and 'localhost' is a valid request-derived RP ID, so the
// zero-WebAuthn-env path (plan 006 Phase 2) is what gets exercised.

const PORT = 3199
const BASE = `http://localhost:${PORT}`

let server: ChildProcess | undefined
let dataDir: string

function secret(): string {
  return randomBytes(48).toString('base64')
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('bare self-host server never became healthy')
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopServer(): Promise<void> {
  const child = server
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = waitForExit(child, 5_000)
  child.kill('SIGTERM')
  if (await stopped) return
  const killed = waitForExit(child, 5_000)
  child.kill('SIGKILL')
  if (!(await killed)) throw new Error('bare self-host server did not exit')
}

function identityCounts(): { members: number; credentials: number } {
  const db = new Database(path.join(dataDir, 'server.db'), { readonly: true })
  try {
    const members = db.prepare('SELECT COUNT(*) AS count FROM members').get() as {
      count: number
    }
    const credentials = db
      .prepare('SELECT COUNT(*) AS count FROM webauthn_credentials')
      .get() as { count: number }
    return { members: members.count, credentials: credentials.count }
  } finally {
    db.close()
  }
}

test.describe('self-host: bare boot → claim → gate closed → invites', () => {
  test.beforeAll(async () => {
    if (!fs.existsSync('dist/index.html')) {
      throw new Error('self-host claim E2E requires `npm run build:spa`; refusing to skip')
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-claim-'))
    // Launch the backend process directly, not through an `npx` wrapper, so
    // teardown signals and awaits the process that actually owns the port.
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // The Phase 0 contract: production boots on secrets alone.
        NODE_ENV: 'production',
        PORT: String(PORT),
        SERVE_SPA: '1',
        SESSION_SECRET: secret(),
        STREAM_TOKEN_SECRET: secret(),
        DEVICE_TOKEN_SECRET: secret(),
        INTERNAL_PRINCIPAL_SECRET: secret(),
        // Keep every data file in the throwaway dir, not the repo.
        SERVER_DB_PATH: path.join(dataDir, 'server.db'),
        IPTV_DB_PATH: path.join(dataDir, 'iptv.db'),
        GRAB_LOG_PATH: path.join(dataDir, 'grabs.jsonl'),
        USAGE_LOG_PATH: path.join(dataDir, 'usage.jsonl'),
        REJECTIONS_PATH: path.join(dataDir, 'rejections.json'),
        USER_FEEDBACK_PATH: path.join(dataDir, 'user-feedback.json'),
        DB_BACKUP_DIR: path.join(dataDir, 'backups'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stderr?.on('data', (d: Buffer) => console.error('[claim-server]', d.toString()))
    await waitForHealth()
  })

  test.afterAll(async () => {
    await stopServer()
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('the full first-owner and invited-member journey', async ({ page, browser }) => {
    // Real WebAuthn, virtual hardware: a CTAP2 resident-key authenticator.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })

    // 1. Unclaimed server advertises claimability and the SPA shows the
    //    claim panel instead of sign-in.
    const status = await page.request.get(`${BASE}/api/setup/status`)
    expect(await status.json()).toEqual({ claimable: true })

    await page.goto(`${BASE}/`)
    await expect(page.getByText('Claim this server').first()).toBeVisible({ timeout: 15_000 })

    // 2. Claim with the boot-minted token (read from the 0600 file the
    //    banner points at) + a passkey.
    const token = fs.readFileSync(path.join(dataDir, '.setup-token'), 'utf8').trim()
    await page.getByLabel('Your name').first().fill('Owner')
    await page.getByLabel('Setup token').first().fill(token)
    await page.getByRole('button', { name: /claim server/i }).first().click()

    // 3. An admin session exists (cookie jar is shared with page.request).
    await expect
      .poll(async () => (await page.request.get(`${BASE}/api/me`)).status(), {
        timeout: 15_000,
      })
      .toBe(200)
    const me = (await (await page.request.get(`${BASE}/api/me`)).json()) as {
      user: { role: string; username: string }
    }
    expect(me.user.role).toBe('admin')
    expect(me.user.username).toBe('Owner')

    // 4. The one-way door closed: no longer claimable, token burned.
    const status2 = await page.request.get(`${BASE}/api/setup/status`)
    expect(await status2.json()).toEqual({ claimable: false })

    // 5. The owner can mint an invite for the next household member —
    //    the native (Plex-free) onboarding path. Same-origin Origin header
    //    satisfies the CSRF gate exactly like the SPA's own fetches.
    const inv = await page.request.post(`${BASE}/api/admin/invites`, {
      headers: { Origin: BASE },
      data: { label: 'first household member' },
    })
    expect(inv.ok(), `invite mint failed: ${inv.status()}`).toBeTruthy()
    const invite = (await inv.json()) as { code?: string; code_hash_prefix?: string }
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{22}$/)

    // 6. A separate browser receives only the URL fragment. Startup removes
    //    it before telemetry or /api/me, keeps the code in memory, and opens
    //    passkey registration. The real route transaction redeems the invite,
    //    persists the credential, and establishes the member cookie together.
    const memberContext = await browser.newContext()
    try {
      const memberPage = await memberContext.newPage()
      const memberCdp = await memberContext.newCDPSession(memberPage)
      await memberCdp.send('WebAuthn.enable')
      await memberCdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })

      await memberPage.goto(`${BASE}/#/invite/${invite.code}`)
      await expect.poll(() => new URL(memberPage.url()).hash).toBe('')
      await expect(memberPage.getByLabel('Invite code').first()).toHaveValue(invite.code!)
      await memberPage.getByLabel('Your name').first().fill('Household member')
      await memberPage.getByRole('button', { name: 'Create passkey' }).first().click()

      await expect
        .poll(async () => (await memberPage.request.get(`${BASE}/api/me`)).status(), {
          timeout: 15_000,
        })
        .toBe(200)
      const memberMe = (await (await memberPage.request.get(`${BASE}/api/me`)).json()) as {
        user: { role: string; username: string; sub: string }
      }
      expect(memberMe.user).toMatchObject({ role: 'user', username: 'Household member' })
      expect(memberMe.user.sub).toMatch(/^local:/)
    } finally {
      await memberContext.close()
    }

    const identitiesAfterRedemption = identityCounts()
    expect(identitiesAfterRedemption).toEqual({ members: 2, credentials: 2 })

    // 7. The same plaintext invite cannot authorize a second identity. Drive
    // the complete registration ceremony in a third isolated cookie jar, then
    // prove the route denied it before persisting either member or credential.
    const rejectedContext = await browser.newContext()
    try {
      const rejectedPage = await rejectedContext.newPage()
      const rejectedCdp = await rejectedContext.newCDPSession(rejectedPage)
      await rejectedCdp.send('WebAuthn.enable')
      await rejectedCdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })

      await rejectedPage.goto(`${BASE}/#/invite/${invite.code}`)
      await expect.poll(() => new URL(rejectedPage.url()).hash).toBe('')
      await expect(rejectedPage.getByLabel('Invite code').first()).toHaveValue(invite.code!)
      await rejectedPage.getByLabel('Your name').first().fill('Rejected member')
      await rejectedPage.getByRole('button', { name: 'Create passkey' }).first().click()

      await expect(rejectedPage.getByRole('alert').first()).toContainText(/invitation-only/i)
      expect((await rejectedPage.request.get(`${BASE}/api/me`)).status()).toBe(401)
    } finally {
      await rejectedContext.close()
    }

    expect(identityCounts()).toEqual(identitiesAfterRedemption)

    // The owner sees the real single-use counter exhausted; the plaintext code
    // never appears in this list and cannot authorize a second member.
    const listed = await page.request.get(`${BASE}/api/admin/invites`)
    expect(listed.ok()).toBe(true)
    const listedBody = (await listed.json()) as {
      invites: Array<{ code_hash_prefix: string; max_uses: number; used_count: number }>
    }
    expect(
      listedBody.invites.find((row) => row.code_hash_prefix === invite.code_hash_prefix),
    ).toMatchObject({ max_uses: 1, used_count: 1 })

    // 8. Optional integrations honestly absent: typed 503s, never 500s.
    for (const [p, err] of [
      ['/api/sonarr/api/v3/series', 'sonarr_not_configured'],
      ['/api/auth/plex/config', 'plex_not_configured'],
    ] as const) {
      const r = await page.request.get(`${BASE}${p}`)
      expect(r.status(), p).toBe(503)
      expect((await r.json()).error, p).toBe(err)
    }
  })
})
