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
// CI gate (M13): set CI_REQUIRE_CROSS_BINDING=1 and this test FAILS
// (rather than silently skipping) when the recommender Python +
// emerald_contracts extension is missing. The `recommender` job in
// .github/workflows/ci.yml builds the PyO3 wheel into recommender/.venv
// and runs the Node suite with that flag set, so a missing or drifted
// extension turns the cross-binding gate red instead of green-by-skip.
//
// When the flag is NOT set (local dev without a built venv, or a Node
// matrix entry that never provisions Python), the test skips so a bare
// `npm test` on a fresh checkout stays green.

import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import * as contracts from '@emerald/contracts-napi'

const PYTHON_PATH = path.resolve(__dirname, '..', '..', 'recommender', '.venv', 'bin', 'python')

// Child-process invocations shell out to a freshly-built Python; under
// CI load the spawn was observed to flake (L5). Bound every call with an
// explicit timeout and retry transient spawn failures so the gate is
// deterministic rather than load-sensitive.
const SPAWN_TIMEOUT_MS = 30_000
const SPAWN_MAX_ATTEMPTS = 3

// When set, a missing Python/extension is a hard failure (CI gate, M13)
// rather than a skip. Anything truthy-but-not-"0"/"false" enables it.
const REQUIRE_CROSS_BINDING = (() => {
  const v = process.env.CI_REQUIRE_CROSS_BINDING
  if (v === undefined) return false
  const normalized = v.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
})()

function probePython(): { ok: boolean; reason: string } {
  if (!existsSync(PYTHON_PATH)) {
    return { ok: false, reason: `recommender venv python not found at ${PYTHON_PATH}` }
  }
  // Retry the import probe — under CI load the first interpreter spawn
  // can be killed by the scheduler before it reports.
  let lastReason = 'unknown'
  for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
    const probe = spawnSync(PYTHON_PATH, ['-c', 'import emerald_contracts'], {
      stdio: 'pipe',
      timeout: SPAWN_TIMEOUT_MS,
      encoding: 'utf-8',
    })
    if (probe.status === 0) return { ok: true, reason: '' }
    const probeErr = probe.error as NodeJS.ErrnoException | undefined
    if (probeErr?.code === 'ETIMEDOUT' || probe.signal !== null) {
      lastReason = `import probe timed out / killed (attempt ${attempt}/${SPAWN_MAX_ATTEMPTS}, signal=${probe.signal ?? 'none'})`
      continue
    }
    // Non-timeout failure (e.g. extension genuinely not installed) —
    // no point retrying.
    lastReason = `emerald_contracts not importable: ${(probe.stderr || '').trim() || `exit ${probe.status}`}`
    break
  }
  return { ok: false, reason: lastReason }
}

const PROBE = probePython()
const HAVE_PYTHON = PROBE.ok

// M13: turn a missing extension into a red gate when explicitly required.
// This runs at module load so the failure is unambiguous even if every
// `it` would otherwise be skipped.
if (REQUIRE_CROSS_BINDING && !HAVE_PYTHON) {
  console.error(
    `[cross-binding] CI_REQUIRE_CROSS_BINDING is set but the PyO3 binding is unavailable: ${PROBE.reason}`,
  )
}

// Run a short Python snippet against the recommender venv, retrying
// transient spawn flakes (timeout / killed-by-signal) but surfacing real
// errors immediately. Returns parsed stdout JSON.
function runPython(scriptLines: string[], env: Record<string, string>): Record<string, unknown> {
  const script = scriptLines.join('\n')
  let lastErr: unknown
  for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
    try {
      const out = execFileSync(PYTHON_PATH, ['-c', script], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: SPAWN_TIMEOUT_MS,
      })
      return JSON.parse(out) as Record<string, unknown>
    } catch (err) {
      lastErr = err
      const e = err as NodeJS.ErrnoException & { signal?: string | null }
      const transient = e.code === 'ETIMEDOUT' || (e.signal != null && e.signal !== '')
      if (transient && attempt < SPAWN_MAX_ATTEMPTS) continue
      throw err
    }
  }
  // Unreachable in practice — the loop either returns or throws — but keep
  // the type-checker happy and preserve the original error if it fires.
  throw lastErr
}

const DECRYPT_SCRIPT = [
  'import emerald_contracts as ec, json, os',
  'key = bytes.fromhex(os.environ["EEX_KEY_HEX"])',
  'token = os.environ["EEX_JWE"]',
  'claims = ec.internal_principal_decrypt({"internal-v1": key}, token)',
  'print(json.dumps(claims))',
]

describe('cross-binding internal-principal (N-API → PyO3)', () => {
  if (REQUIRE_CROSS_BINDING && !HAVE_PYTHON) {
    // Single, explicit red test so the CI gate is unmistakable. Without
    // this, an all-skipped describe block would report green even under
    // CI_REQUIRE_CROSS_BINDING.
    it('requires the PyO3 cross-binding to be available (CI_REQUIRE_CROSS_BINDING=1)', () => {
      throw new Error(
        `Cross-binding gate required but PyO3 binding unavailable: ${PROBE.reason}. ` +
          `Build the emerald-contracts wheel into recommender/.venv before running this job.`,
      )
    })
    return
  }

  // Local dev / Node-only matrix entries without Python: skip cleanly.
  if (!HAVE_PYTHON) {
    it.skip(`skipped — PyO3 binding unavailable (${PROBE.reason})`, () => {})
    return
  }

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
    const decoded = runPython(DECRYPT_SCRIPT, {
      EEX_KEY_HEX: Buffer.from(key).toString('hex'),
      EEX_JWE: jwe,
    })

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

    const decoded = runPython(DECRYPT_SCRIPT, {
      EEX_KEY_HEX: Buffer.from(key).toString('hex'),
      EEX_JWE: jwe,
    })

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

    const decoded = runPython(
      [
        'import emerald_contracts as ec, json, os',
        'key = bytes.fromhex(os.environ["EEX_KEY_HEX"])',
        'claims = json.loads(os.environ["EEX_CLAIMS"])',
        'token = ec.internal_principal_encrypt(key, "internal-v1", claims)',
        'decoded = ec.internal_principal_decrypt({"internal-v1": key}, token)',
        'print(json.dumps(decoded))',
      ],
      {
        EEX_KEY_HEX: Buffer.from(key).toString('hex'),
        EEX_CLAIMS: JSON.stringify(claims),
      },
    )

    for (const k of Object.keys(claims) as Array<keyof typeof claims>) {
      expect(decoded[k]).toBe(claims[k])
    }
  })
})
