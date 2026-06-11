import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contracts } from './contractsBinding.js'

// index.d.ts is hand-authored and kept in lock-step with the Rust #[napi]
// exports (the napi-rs v3 CLI does not auto-emit types for napi 2.16
// crates). Parse the declared function names from it so this test follows
// the .d.ts instead of a hardcoded list that can rot.
const DTS_PATH = resolve(
  new URL(
    '../../crates/emerald-contracts-napi/index.d.ts',
    import.meta.url,
  ).pathname,
)

function declaredFunctions(): string[] {
  const dts = readFileSync(DTS_PATH, 'utf-8')
  const names = [...dts.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
  // The dts-guard exists because this file was once clobbered to 0 bytes
  // (fixed 1ae47c0); an empty parse here means the guard failed again.
  expect(names.length).toBeGreaterThanOrEqual(13)
  return names
}

describe('contractsBinding', () => {
  it('exports the contracts NAPI module with key functions available', () => {
    expect(contracts).toBeDefined()
    // The NAPI module exports crypto functions; verify they exist.
    // These are the primary contract surface for cryptographic operations.
    expect(typeof contracts.streamTokenSign).toBe('function')
    expect(typeof contracts.streamTokenVerify).toBe('function')
    expect(typeof contracts.deviceTokenEncrypt).toBe('function')
    expect(typeof contracts.deviceTokenDecrypt).toBe('function')
  })

  it('every function declared in index.d.ts exists on the loaded binding', () => {
    const bound = contracts as unknown as Record<string, unknown>
    for (const name of declaredFunctions()) {
      expect(typeof bound[name], `missing/non-function export: ${name}`).toBe(
        'function',
      )
    }
  })

  it('the binding exports no functions absent from index.d.ts (two-way lockstep)', () => {
    // A Rust #[napi] export without a matching .d.ts declaration would be
    // invisible to TS consumers — surface drift in either direction fails.
    const declared = new Set(declaredFunctions())
    const actual = Object.keys(contracts).filter(
      (k) =>
        typeof (contracts as unknown as Record<string, unknown>)[k] ===
        'function',
    )
    expect(actual.sort()).toEqual([...declared].sort())
  })
})

// ---------------------------------------------------------------------------
// tests/vectors/device-token-kid-rotation.json — executed through the SAME
// binding functions server/session.ts uses to mint and verify device tokens
// (deviceTokenEncrypt / deviceTokenDecrypt, kid-aware multi-key dispatch).
// The Rust harness (crates/emerald-contracts/tests/vectors.rs) runs the
// same file against the crate directly.
// ---------------------------------------------------------------------------

interface KidRotationVector {
  keyMap: Record<
    string,
    { testSecretUtf8: string; hkdfInfo: string; derivedKeyHex: string }
  >
  vectors: Array<{
    name: string
    kid: string | null
    expectedResult: 'accepted' | 'rejected'
    expectedClaims?: Record<string, string | number>
    expectedErrorCode?: string
    sampleToken?: string
    syntheticToken?: string
  }>
}

const kidVectorPath = resolve(
  new URL(
    '../../tests/vectors/device-token-kid-rotation.json',
    import.meta.url,
  ).pathname,
)

describe('device-token-kid-rotation.json vectors (§3.6)', () => {
  const file = JSON.parse(
    readFileSync(kidVectorPath, 'utf-8'),
  ) as KidRotationVector

  const keys = Object.entries(file.keyMap).map(([kid, entry]) => ({
    kid,
    key: Buffer.from(entry.derivedKeyHex, 'hex'),
  }))

  it('hkdfDeviceToken reproduces the v1 derived key (the binding pins the v1 info string)', () => {
    const v1 = file.keyMap['device-v1']
    expect(v1.hkdfInfo).toBe('eex/device-token/v1')
    const derived = contracts.hkdfDeviceToken(
      Buffer.from(v1.testSecretUtf8, 'utf-8'),
    )
    expect(Buffer.from(derived.bytes).toString('hex')).toBe(v1.derivedKeyHex)
  })

  // Vector claims are the canonical snake_case wire shape; the binding's
  // JS surface is camelCase. This mapping IS part of the contract under
  // test — a rename on either side must fail here.
  function toJsClaims(wire: Record<string, string | number>) {
    return {
      aud: wire.aud as string,
      iss: wire.iss as string,
      sub: wire.sub as string,
      role: wire.role as string,
      authMode: wire.auth_mode as string,
      deviceId: wire.device_id as string,
      devicePlatform: wire.device_platform as string,
      serverId: wire.server_id as string,
      jti: wire.jti as string,
      iat: wire.iat as number,
      nbf: wire.nbf as number,
      exp: wire.exp as number,
    }
  }

  for (const vec of file.vectors) {
    if (vec.expectedResult === 'accepted') {
      it(`[${vec.name}] fresh mint with kid=${vec.kid} round-trips through the multi-key verifier`, () => {
        const claims = toJsClaims(vec.expectedClaims!)
        const entry = keys.find((k) => k.kid === vec.kid)!
        const token = contracts.deviceTokenEncrypt(entry.key, vec.kid!, claims)
        expect(contracts.deviceTokenDecrypt(keys, token)).toEqual(claims)
      })

      it(`[${vec.name}] pinned sampleToken decrypts to expectedClaims`, () => {
        const claims = toJsClaims(vec.expectedClaims!)
        expect(contracts.deviceTokenDecrypt(keys, vec.sampleToken!)).toEqual(
          claims,
        )
      })
    } else {
      it(`[${vec.name}] hard-rejects (${vec.expectedErrorCode})`, () => {
        const pattern =
          vec.expectedErrorCode === 'kid_unknown' ? /UnknownKid/ : /BadHeader/
        expect(() =>
          contracts.deviceTokenDecrypt(keys, vec.syntheticToken!),
        ).toThrow(pattern)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// tests/vectors/internal-principal.json — mint side via the binding (the
// production path internalPrincipal.ts uses). The N-API surface is
// intentionally mint-only (Hono never verifies its own principals); the
// decrypt half of the round trip is executed by the Rust harness and the
// PyO3 parity suite against the same vector file.
// ---------------------------------------------------------------------------

interface InternalPrincipalVector {
  jwe_shape: { protected_header: { alg: string; enc: string; kid: string } }
  round_trip_vector: {
    claims_input: Record<string, string | number>
    secret_hex_utf8: string
    derived_key_hex: string
  }
}

const ipVectorPath = resolve(
  new URL('../../tests/vectors/internal-principal.json', import.meta.url)
    .pathname,
)

describe('internal-principal.json vector (§4 Hybrid D) — mint side', () => {
  const file = JSON.parse(
    readFileSync(ipVectorPath, 'utf-8'),
  ) as InternalPrincipalVector
  const rt = file.round_trip_vector

  it('hkdfInternalPrincipal reproduces the pinned derived key', () => {
    const derived = contracts.hkdfInternalPrincipal(
      Buffer.from(rt.secret_hex_utf8, 'utf-8'),
    )
    expect(Buffer.from(derived.bytes).toString('hex')).toBe(rt.derived_key_hex)
  })

  it('mints a JWE with the pinned protected-header shape and a unique nonce per encrypt', () => {
    const key = Buffer.from(rt.derived_key_hex, 'hex')
    const c = rt.claims_input
    const claims = {
      iss: c.iss as string,
      sub: c.sub as string,
      role: c.role as string,
      authMode: c.auth_mode as string,
      serverId: c.server_id as string,
      deviceId: c.device_id as string,
      reqId: c.req_id as string,
      iat: c.iat as number,
      exp: c.exp as number,
    }
    const kid = file.jwe_shape.protected_header.kid
    const token = contracts.internalPrincipalEncrypt(key, kid, claims)

    const [headerB64, encKey, iv, , tag] = token.split('.')
    expect(JSON.parse(Buffer.from(headerB64, 'base64url').toString())).toEqual(
      file.jwe_shape.protected_header,
    )
    // alg:dir — empty encrypted-key segment; 12-byte IV; 16-byte tag.
    expect(encKey).toBe('')
    expect(Buffer.from(iv, 'base64url')).toHaveLength(12)
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16)

    // negative_checks.nonce-uniqueness: random IV per encrypt is mandatory.
    const token2 = contracts.internalPrincipalEncrypt(key, kid, claims)
    expect(token2).not.toBe(token)
  })
})
