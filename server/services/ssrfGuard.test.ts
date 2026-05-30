import { describe, it, expect, afterEach } from 'vitest'
import {
  isPublicHttpsUpstream,
  assertResolvesPublic,
  SsrfBlockedError,
  __setSsrfLookupForTests,
} from './ssrfGuard.js'

const ok = (u: string) => isPublicHttpsUpstream(new URL(u))

describe('isPublicHttpsUpstream', () => {
  it('allows legit public CDN hosts over http OR https (incl. cross-CDN providers)', () => {
    expect(ok('https://cdn.example.com/foo/seg.ts')).toBe(true)
    expect(ok('https://edge-17.provider.net/hls/seg-001.ts')).toBe(true)
    expect(ok('https://panel.someiptv.tv:8080/live/u/p/1.ts')).toBe(true)
    // http to a PUBLIC host is allowed: scheme is irrelevant to SSRF, and many
    // providers 30x-redirect an https panel to a plain-http public CDN
    // (mybunny.tv -> http://turbobunny.net). The address checks still apply.
    expect(ok('http://cdn.example.com/seg.ts')).toBe(true)
    expect(ok('http://turbobunny.net/live/u/p/1.ts')).toBe(true)
  })

  it('rejects non-http(s) schemes', () => {
    expect(ok('file:///etc/passwd')).toBe(false)
    expect(ok('gopher://example.com/x')).toBe(false)
    expect(ok('ftp://example.com/x')).toBe(false)
  })

  it('still blocks http to PRIVATE/internal targets (scheme change does not weaken address checks)', () => {
    expect(ok('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(ok('http://10.0.0.5/seg.ts')).toBe(false)
    expect(ok('http://recommender:8000/internal')).toBe(false)
    expect(ok('http://localhost/seg.ts')).toBe(false)
  })

  it('rejects cloud metadata + link-local', () => {
    expect(ok('https://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(ok('https://169.254.0.1/')).toBe(false)
  })

  it('rejects private IPv4 ranges', () => {
    expect(ok('https://10.0.0.5/seg.ts')).toBe(false)
    expect(ok('https://192.168.1.10/seg.ts')).toBe(false)
    expect(ok('https://172.16.5.5/seg.ts')).toBe(false)
    expect(ok('https://172.31.255.255/seg.ts')).toBe(false)
    expect(ok('https://127.0.0.1/seg.ts')).toBe(false)
    expect(ok('https://0.0.0.0/seg.ts')).toBe(false)
    expect(ok('https://100.64.0.1/seg.ts')).toBe(false) // CGNAT
  })

  it('allows public IPv4 that is adjacent to private ranges', () => {
    expect(ok('https://172.15.0.1/seg.ts')).toBe(true) // just below 172.16/12
    expect(ok('https://172.32.0.1/seg.ts')).toBe(true) // just above
    expect(ok('https://11.0.0.1/seg.ts')).toBe(true)
    expect(ok('https://8.8.8.8/seg.ts')).toBe(true)
  })

  it('rejects loopback + unique-local + link-local IPv6', () => {
    expect(ok('https://[::1]/seg.ts')).toBe(false)
    expect(ok('https://[fd00::1]/seg.ts')).toBe(false)
    expect(ok('https://[fe80::1]/seg.ts')).toBe(false)
    expect(ok('https://[::ffff:10.0.0.1]/seg.ts')).toBe(false) // IPv4-mapped private
  })

  it('rejects bare/internal hostnames (docker service DNS)', () => {
    expect(ok('https://recommender/seg.ts')).toBe(false)
    expect(ok('https://localhost/seg.ts')).toBe(false)
    expect(ok('https://media-core/api')).toBe(false)
    expect(ok('https://db.internal/x')).toBe(false)
    expect(ok('https://host.local/x')).toBe(false)
  })
})

describe('assertResolvesPublic (DNS rebinding defense)', () => {
  afterEach(() => __setSsrfLookupForTests(null))

  it('rejects a public hostname that resolves to cloud metadata', async () => {
    __setSsrfLookupForTests(async () => [{ address: '169.254.169.254' }])
    await expect(assertResolvesPublic('rebind.attacker.example')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
  })

  it('rejects when ANY of several resolved addresses is private', async () => {
    __setSsrfLookupForTests(async () => [
      { address: '203.0.113.10' }, // public
      { address: '10.0.0.5' }, // private — one bad record taints the set
    ])
    await expect(assertResolvesPublic('mixed.example')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('rejects a hostname that resolves to a private IPv6 address', async () => {
    __setSsrfLookupForTests(async () => [{ address: 'fd00::1' }])
    await expect(assertResolvesPublic('v6.example')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('allows a hostname that resolves entirely to public addresses', async () => {
    __setSsrfLookupForTests(async () => [{ address: '8.8.8.8' }, { address: '203.0.113.1' }])
    await expect(assertResolvesPublic('good.example')).resolves.toBeUndefined()
  })

  it('rejects when DNS resolution fails (fail closed)', async () => {
    __setSsrfLookupForTests(async () => {
      throw new Error('ENOTFOUND')
    })
    await expect(assertResolvesPublic('nxdomain.example')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('validates an IP literal directly without a DNS round-trip', async () => {
    // No resolver override needed — a private literal is rejected synchronously.
    await expect(assertResolvesPublic('10.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})
