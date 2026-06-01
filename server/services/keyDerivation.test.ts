import { describe, it, expect } from 'vitest'
import { hkdfSync } from 'node:crypto'
import {
  deriveKey,
  INFO_SESSION,
  INFO_DEVICE_TOKEN,
  INFO_STREAM_TOKEN,
  INFO_INTERNAL_PRINCIPAL,
} from './keyDerivation.js'

describe('deriveKey', () => {
  it('returns a 32-byte Buffer', () => {
    const key = deriveKey('secret', INFO_SESSION)
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
  })

  it('is deterministic for the same secret+info', () => {
    const a = deriveKey('mysecret', INFO_SESSION)
    const b = deriveKey('mysecret', INFO_SESSION)
    expect(a.equals(b)).toBe(true)
  })

  it('pins a known output vector (regression guard)', () => {
    // Locks the empty-salt + SHA-256 + 32-byte choices in keyDerivation.ts;
    // any silent change to salt/length/hash breaks this test.
    expect(deriveKey('mysecret', INFO_SESSION).toString('hex')).toBe(
      '56f91f2e6d675281036369aa5c320751eedefc2cc858d932affa5e3f859d15e6',
    )
  })

  it('domain-separates by info string', () => {
    const session = deriveKey('mysecret', INFO_SESSION)
    expect(session.equals(deriveKey('mysecret', INFO_DEVICE_TOKEN))).toBe(false)
    expect(session.equals(deriveKey('mysecret', INFO_STREAM_TOKEN))).toBe(false)
    expect(session.equals(deriveKey('mysecret', INFO_INTERNAL_PRINCIPAL))).toBe(
      false,
    )

    // All four INFO_* constants must yield mutually distinct keys.
    const infos = [
      INFO_SESSION,
      INFO_DEVICE_TOKEN,
      INFO_STREAM_TOKEN,
      INFO_INTERNAL_PRINCIPAL,
    ]
    const hexes = new Set(
      infos.map((info) => deriveKey('mysecret', info).toString('hex')),
    )
    expect(hexes.size).toBe(4)
  })

  it('separates by secret', () => {
    const a = deriveKey('secretA', INFO_SESSION)
    const b = deriveKey('secretB', INFO_SESSION)
    expect(a.equals(b)).toBe(false)
  })

  it('handles empty-string info and empty-string secret without throwing', () => {
    // Boundary: documents current behavior — do NOT assert it throws.
    let key: Buffer | undefined
    expect(() => {
      key = deriveKey('', '')
    }).not.toThrow()
    expect(key).toBeDefined()
    expect(key!.length).toBe(32)
  })
})

describe('INFO_* label invariants', () => {
  it('are the exact canonical strings', () => {
    // Guards against accidental rename = accidental key rotation.
    expect(INFO_SESSION).toBe('eex/session/v1')
    expect(INFO_DEVICE_TOKEN).toBe('eex/device-token/v1')
    expect(INFO_STREAM_TOKEN).toBe('eex/stream-token/v1')
    expect(INFO_INTERNAL_PRINCIPAL).toBe('eex/internal-principal/v1')
  })

  it('are pure ASCII (cross-platform byte-equality)', () => {
    const labels = [
      INFO_SESSION,
      INFO_DEVICE_TOKEN,
      INFO_STREAM_TOKEN,
      INFO_INTERNAL_PRINCIPAL,
    ]
    for (const label of labels) {
      for (let i = 0; i < label.length; i++) {
        expect(label.charCodeAt(i)).toBeLessThan(128)
      }
      // UTF-8 and Latin-1 must produce byte-identical sequences per the
      // file's documented Rust/Swift byte-equality guarantee.
      expect(
        Buffer.from(label, 'utf8').equals(Buffer.from(label, 'latin1')),
      ).toBe(true)
    }
  })
})

describe('RFC 5869 conformance', () => {
  it('matches RFC 5869 Appendix A.1 (SHA-256) test vector', () => {
    const ikm = Buffer.alloc(22, 0x0b)
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex')
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex')
    const L = 42
    expect(Buffer.from(hkdfSync('sha256', ikm, salt, info, L)).toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })

  it('matches RFC 5869 Appendix A.2 zero-length salt+info behavior shape', () => {
    // Documents that empty salt — the exact configuration deriveKey uses —
    // is accepted and produces full-length output.
    const out = hkdfSync('sha256', Buffer.alloc(22, 0x0b), '', '', 42)
    expect(Buffer.from(out).length).toBe(42)
  })
})
