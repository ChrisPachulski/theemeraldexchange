// Cross-binding interop check for the §4 internal-principal JWE.
//
// Today's parity tests (tests/vectors/internal-principal.json, the
// existing PyO3 parity tests, the Rust unit tests) each round-trip
// *within* a single binding. They prove a binding agrees with itself,
// but not that a JWE minted by N-API in Hono can be decrypted by PyO3
// in the recommender. M3 cutover depends on exactly that property,
// and a divergence would only manifest in production.
//
// This test pins it: mint via the actual prod path (N-API binding,
// same one server/services/internalPrincipal.ts uses), shell out to
// the recommender's Python venv to decrypt via the PyO3 binding, then
// diff the decoded claims against the input. Both bindings consume
// the same canonical Rust crate, so this guards against the binding
// shim layer drifting (claim-name renames, optional-handling
// differences, kid dispatch shape).
//
// Skipped automatically when `recommender/.venv/bin/python` isn't
// present or doesn't have `emerald_contracts` installed. CI doesn't
// run this today because the recommender Python job and the Node
// test job are separate matrix entries with different toolchains;
// local dev hits it on every `npm test`.

import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import * as contracts from '@emerald/contracts-napi'

const PYTHON_PATH = path.resolve(__dirname, '..', '..', 'recommender', '.venv', 'bin', 'python')

function pythonAvailable(): boolean {
  if (!existsSync(PYTHON_PATH)) return false
  const probe = spawnSync(PYTHON_PATH, ['-c', 'import emerald_contracts'], {
    stdio: 'pipe',
  })
  return probe.status === 0
}

const HAVE_PYTHON = pythonAvailable()

describe.skipIf(!HAVE_PYTHON)('cross-binding internal-principal (N-API → PyO3)', () => {
  it('Hono-minted JWE decrypts cleanly under PyO3 with identical claims', () => {
    // Fixed secret produces a stable HKDF-derived key. Same vector as
    // tests/vectors/internal-principal.json secret_hex_utf8.
    const secret = Buffer.from('TEST_SECRET_32_CHARS_FIXED_VALUE_X', 'utf-8')
    const key = contracts.hkdfInternalPrincipal(secret).bytes

    const claims = {
      iss: 'eex',
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: '01HABCDEFGHJKMNPQRSTVWXYZ0',
      deviceId: '01HXYZ01234567890ABCDEFGHJ',
      reqId: '01HXYZ01234567890ABCDEFGHK',
      iat: 1748169600,
      exp: 1748169660,
    }

    const jwe = contracts.internalPrincipalEncrypt(key, 'internal-v1', claims)

    // Spawn Python with the JWE + key passed via env. Avoids stdin
    // parsing and keeps the test hermetic. Python prints decoded
    // claims as JSON to stdout; we parse and compare.
    const out = execFileSync(
      PYTHON_PATH,
      [
        '-c',
        [
          'import emerald_contracts as ec, json, os',
          'key = bytes.fromhex(os.environ["EEX_KEY_HEX"])',
          'token = os.environ["EEX_JWE"]',
          'claims = ec.internal_principal_decrypt({"internal-v1": key}, token)',
          'print(json.dumps(claims))',
        ].join('\n'),
      ],
      {
        env: {
          ...process.env,
          EEX_KEY_HEX: Buffer.from(key).toString('hex'),
          EEX_JWE: jwe,
        },
        encoding: 'utf-8',
      },
    )

    const decoded = JSON.parse(out) as Record<string, unknown>

    // PyO3 returns snake_case (matches the Rust struct's serde renames);
    // N-API took camelCase on input. Both bindings feed the same
    // canonical InternalPrincipalClaims struct, so the wire bytes
    // are produced once and decoded once.
    expect(decoded.iss).toBe(claims.iss)
    expect(decoded.sub).toBe(claims.sub)
    expect(decoded.role).toBe(claims.role)
    expect(decoded.auth_mode).toBe(claims.authMode)
    expect(decoded.server_id).toBe(claims.serverId)
    expect(decoded.device_id).toBe(claims.deviceId)
    expect(decoded.req_id).toBe(claims.reqId)
    expect(decoded.iat).toBe(claims.iat)
    expect(decoded.exp).toBe(claims.exp)
  })

  it('omitted deviceId round-trips as null/None through PyO3', () => {
    // Cookie-session callers (the common case) leave deviceId
    // undefined. Per the N-API binding contract, the property is
    // omitted entirely rather than passed as null — confirm the
    // PyO3 decode surfaces this as None, not as the literal string
    // "undefined" or some other mishandling.
    const secret = Buffer.from('TEST_SECRET_32_CHARS_FIXED_VALUE_X', 'utf-8')
    const key = contracts.hkdfInternalPrincipal(secret).bytes

    const claims = {
      iss: 'eex',
      sub: 'plex:99999',
      role: 'admin',
      authMode: 'plex',
      serverId: '01HABCDEFGHJKMNPQRSTVWXYZ0',
      reqId: '01HXYZ01234567890ABCDEFGHL',
      iat: 1748169600,
      exp: 1748169660,
    }

    const jwe = contracts.internalPrincipalEncrypt(key, 'internal-v1', claims)

    const out = execFileSync(
      PYTHON_PATH,
      [
        '-c',
        [
          'import emerald_contracts as ec, json, os',
          'key = bytes.fromhex(os.environ["EEX_KEY_HEX"])',
          'token = os.environ["EEX_JWE"]',
          'claims = ec.internal_principal_decrypt({"internal-v1": key}, token)',
          'print(json.dumps(claims))',
        ].join('\n'),
      ],
      {
        env: {
          ...process.env,
          EEX_KEY_HEX: Buffer.from(key).toString('hex'),
          EEX_JWE: jwe,
        },
        encoding: 'utf-8',
      },
    )

    const decoded = JSON.parse(out) as Record<string, unknown>
    expect(decoded.device_id).toBeNull()
    expect(decoded.sub).toBe(claims.sub)
    expect(decoded.role).toBe('admin')
  })

  it('PyO3-minted JWE decrypts cleanly under PyO3 with identical claims (full cycle through Python encrypt path)', () => {
    // Reverse-shape check: prove that the snake_case→camelCase mapping
    // on the encrypt side is symmetric. PyO3 takes snake_case input,
    // PyO3 also returns snake_case output. The Rust crate handles
    // the wire-format renames internally. If a future refactor adds
    // camelCase aliases to the Rust struct, this test catches the
    // case where the PyO3 binding silently drops a field.
    //
    // N-API doesn't have internal_principal_decrypt (Hono only mints,
    // never receives) so we can't do N-API mint → PyO3 decrypt → re-
    // mint → N-API decrypt round-trip. This is the closest thing.
    const secret = Buffer.from('TEST_SECRET_32_CHARS_FIXED_VALUE_X', 'utf-8')
    const key = contracts.hkdfInternalPrincipal(secret).bytes

    const claims = {
      iss: 'eex',
      sub: 'plex:54321',
      role: 'user',
      auth_mode: 'plex',
      server_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
      device_id: '01HXYZ01234567890ABCDEFGHM',
      req_id: '01HXYZ01234567890ABCDEFGHN',
      iat: 1748169600,
      exp: 1748169660,
    }

    const out = execFileSync(
      PYTHON_PATH,
      [
        '-c',
        [
          'import emerald_contracts as ec, json, os',
          'key = bytes.fromhex(os.environ["EEX_KEY_HEX"])',
          'claims = json.loads(os.environ["EEX_CLAIMS"])',
          'token = ec.internal_principal_encrypt(key, "internal-v1", claims)',
          'decoded = ec.internal_principal_decrypt({"internal-v1": key}, token)',
          'print(json.dumps(decoded))',
        ].join('\n'),
      ],
      {
        env: {
          ...process.env,
          EEX_KEY_HEX: Buffer.from(key).toString('hex'),
          EEX_CLAIMS: JSON.stringify(claims),
        },
        encoding: 'utf-8',
      },
    )

    const decoded = JSON.parse(out) as Record<string, unknown>
    for (const k of Object.keys(claims) as Array<keyof typeof claims>) {
      expect(decoded[k]).toBe(claims[k])
    }
  })
})
