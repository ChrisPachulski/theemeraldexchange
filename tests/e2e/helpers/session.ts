// Test sign-in for the e2e integration tier. There is no provider ceremony a
// headless browser can complete (Apple/Google/WorkOS), and the gateway ships
// no test-only login route, so the spec mints the same `eex.session` cookie
// the gateway mints (crates/auth/src/session.rs): a JWE, alg dir + enc
// A256GCM, under HKDF-SHA256(SESSION_SECRET, salt '', info 'eex/session/v1').
// It works only because integrationServer.ts boots the gateway with the
// throwaway E2E_SESSION_SECRET below.

import { hkdfSync } from 'crypto'
import { EncryptJWT } from 'jose'
import type { Page } from '@playwright/test'

/** The gateway's SESSION_SECRET in the integration tier (never a real one). */
export const E2E_SESSION_SECRET = 'test-secret-test-secret-test-secret-test-secret'

/** The owner-bootstrap sub the specs sign in as: admin via ADMIN_SUBS, so no
 *  members row is needed. A `local:` sub (Crockford ULID), not a Plex one:
 *  the gateway refuses plex sessions. */
export const E2E_ADMIN_SUB = 'local:01JE2E00000000000000000000'

async function mintSession(): Promise<string> {
  const key = new Uint8Array(hkdfSync('sha256', E2E_SESSION_SECRET, '', 'eex/session/v1', 32))
  return new EncryptJWT({ sub: E2E_ADMIN_SUB, username: 'e2e-admin', role: 'admin', auth_mode: 'local' })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .encrypt(key)
}

/** Put an admin session cookie for `baseURL` (the Vite origin the specs
 *  browse) in the page's browser context. page.request shares the jar, so
 *  API calls from the spec are authenticated too. */
export async function loginAsAdmin(page: Page, baseURL: string | undefined): Promise<void> {
  if (!baseURL) throw new Error('loginAsAdmin needs the playwright baseURL')
  await page.context().addCookies([
    { name: 'eex.session', value: await mintSession(), url: baseURL, httpOnly: true, sameSite: 'Lax' },
  ])
}
