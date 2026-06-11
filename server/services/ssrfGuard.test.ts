import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  isPublicHttpsUpstream,
  assertResolvesPublic,
  guardedFetch,
  guardedFetchTrustedOrigin,
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

  it('rejects special-purpose IPv4 ranges (benchmarking, IETF, 6to4 relay)', () => {
    expect(ok('https://198.18.0.1/seg.ts')).toBe(false) // benchmarking 198.18/15
    expect(ok('https://198.19.255.255/seg.ts')).toBe(false) // upper half of /15
    expect(ok('https://192.0.0.1/seg.ts')).toBe(false) // IETF 192.0.0.0/24
    expect(ok('https://192.88.99.1/seg.ts')).toBe(false) // 6to4 relay anycast
  })

  it('allows public IPv4 that is adjacent to private ranges', () => {
    expect(ok('https://172.15.0.1/seg.ts')).toBe(true) // just below 172.16/12
    expect(ok('https://172.32.0.1/seg.ts')).toBe(true) // just above
    expect(ok('https://11.0.0.1/seg.ts')).toBe(true)
    expect(ok('https://8.8.8.8/seg.ts')).toBe(true)
    expect(ok('https://198.17.255.255/seg.ts')).toBe(true) // just below 198.18/15
    expect(ok('https://198.20.0.1/seg.ts')).toBe(true) // just above 198.18/15
    expect(ok('https://192.0.1.1/seg.ts')).toBe(true) // adjacent to 192.0.0.0/24
    expect(ok('https://192.88.100.1/seg.ts')).toBe(true) // adjacent to 192.88.99/24
  })

  it('rejects loopback + unique-local + link-local + site-local + NAT64 IPv6', () => {
    expect(ok('https://[::1]/seg.ts')).toBe(false)
    expect(ok('https://[fd00::1]/seg.ts')).toBe(false)
    expect(ok('https://[fe80::1]/seg.ts')).toBe(false)
    expect(ok('https://[fec0::1]/seg.ts')).toBe(false) // site-local (deprecated)
    expect(ok('https://[feff::1]/seg.ts')).toBe(false) // top of fec0::/10
    expect(ok('https://[64:ff9b::a00:1]/seg.ts')).toBe(false) // NAT64 → 10.0.0.1
    expect(ok('https://[64:ff9b::808:808]/seg.ts')).toBe(false) // NAT64 even to public v4
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

describe('egress (guardedFetch / guardedFetchTrustedOrigin)', () => {
  // --- scripted-fetch harness ---------------------------------------------
  // egress() calls the GLOBAL fetch with `redirect: 'manual'` and follows
  // Location headers itself. We stub globalThis.fetch with an ordered script
  // of responses, recording every (url, init) so we can assert the exact hop
  // sequence. If the loop asks for more hops than scripted we throw loudly so
  // an unexpected extra fetch surfaces as a failure rather than a hang.

  type ScriptStep =
    | { kind: 'redirect'; status?: number; location: string | null }
    | { kind: 'terminal'; status?: number; body?: string }

  interface FetchCall {
    url: string
    init: RequestInit | undefined
  }

  let originalFetch: typeof globalThis.fetch
  let calls: FetchCall[]

  function makeResponse(step: ScriptStep): Response {
    if (step.kind === 'redirect') {
      const headers: Record<string, string> = {}
      if (step.location !== null) headers.location = step.location
      return new Response(null, { status: step.status ?? 302, headers })
    }
    return new Response(step.body ?? 'OK', { status: step.status ?? 200 })
  }

  function scriptFetch(steps: ScriptStep[]): void {
    let i = 0
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      if (i >= steps.length) {
        throw new Error(
          `unexpected extra fetch (call #${i + 1}) to ${url}; script had ${steps.length} step(s)`,
        )
      }
      return makeResponse(steps[i++])
    }) as typeof globalThis.fetch
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
    // Permissive DNS by default so guardHop's assertResolvesPublic passes for
    // any public-looking name. Individual tests override for rejection paths.
    __setSsrfLookupForTests(async () => [{ address: '8.8.8.8' }])
  })

  afterEach(() => {
    __setSsrfLookupForTests(null)
    globalThis.fetch = originalFetch
  })

  // (a) public -> public 302 -> 200, both hops manual.
  it('guardedFetch follows a single public->public 302 and returns the final 200', async () => {
    scriptFetch([
      { kind: 'redirect', location: 'https://cdn2.example.com/seg-final.ts' },
      { kind: 'terminal', status: 200, body: 'OK' },
    ])
    const res = await guardedFetch('https://cdn.example.com/a/seg.ts')
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([
      'https://cdn.example.com/a/seg.ts',
      'https://cdn2.example.com/seg-final.ts',
    ])
    // Every hop must have been issued with redirect: 'manual'.
    for (const c of calls) {
      expect((c.init as RequestInit).redirect).toBe('manual')
    }
  })

  // (b) guardedFetch blocks a redirect to a private/internal target; the
  // internal URL is never fetched (guard fires before the second fetch).
  it('guardedFetch BLOCKS a 302 into a private IPv4 target before fetching it', async () => {
    scriptFetch([
      { kind: 'redirect', location: 'http://10.0.0.5/seg.ts' },
      // No second step scripted: if egress fetched the internal URL it would
      // throw "unexpected extra fetch", which is also a failure — but the
      // string guard should reject first.
    ])
    await expect(guardedFetch('https://cdn.example.com/a/seg.ts')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://cdn.example.com/a/seg.ts')
  })

  it('guardedFetch BLOCKS a 302 into an internal service hostname', async () => {
    scriptFetch([{ kind: 'redirect', location: 'http://recommender:8000/x' }])
    await expect(guardedFetch('https://cdn.example.com/a/seg.ts')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
    expect(calls).toHaveLength(1)
  })

  // (c) DNS rebinding on a redirect target: public-looking host that resolves
  // to a private address for that specific host only.
  it('guardedFetch blocks a redirect to a public host that DNS-rebinds to a private address', async () => {
    __setSsrfLookupForTests(async (host: string) =>
      host === 'rebind.attacker.example'
        ? [{ address: '169.254.169.254' }]
        : [{ address: '8.8.8.8' }],
    )
    scriptFetch([
      { kind: 'redirect', location: 'https://rebind.attacker.example/seg.ts' },
    ])
    await expect(guardedFetch('https://cdn.example.com/a/seg.ts')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
    // The string guard passes (public-looking name) so the DNS check is what
    // rejects; the rebind host is never actually fetched.
    expect(calls.map((c) => c.url)).toEqual(['https://cdn.example.com/a/seg.ts'])
  })

  // (d) trusted origin: plain-http initial hop fetched UNGUARDED. Prove it by
  // making the DNS stub throw — if guardHop ran on hop 0 it would reject.
  it('guardedFetchTrustedOrigin fetches an unguarded plain-http initial origin', async () => {
    __setSsrfLookupForTests(async () => {
      throw new Error('DNS must not be consulted on the trusted initial hop')
    })
    scriptFetch([{ kind: 'terminal', status: 200, body: 'OK' }])
    const res = await guardedFetchTrustedOrigin('http://creds.provider.tv:8080/live/u/p/1.ts')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://creds.provider.tv:8080/live/u/p/1.ts')
  })

  // (e) trusted origin STILL guards a redirect into an internal host.
  it('guardedFetchTrustedOrigin still blocks a redirect from the trusted origin into localhost', async () => {
    scriptFetch([{ kind: 'redirect', location: 'http://localhost/admin' }])
    await expect(
      guardedFetchTrustedOrigin('http://creds.provider.tv:8080/live/u/p/1.ts'),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    // Only the trusted origin was fetched; the internal redirect target was not.
    expect(calls.map((c) => c.url)).toEqual([
      'http://creds.provider.tv:8080/live/u/p/1.ts',
    ])
  })

  // (f) redirect-depth bound. 6 consecutive redirects (> MAX_REDIRECTS=5) throws.
  it('guardedFetch rejects after exceeding MAX_REDIRECTS (6 redirects)', async () => {
    scriptFetch([
      { kind: 'redirect', location: 'https://h1.example.com/x' },
      { kind: 'redirect', location: 'https://h2.example.com/x' },
      { kind: 'redirect', location: 'https://h3.example.com/x' },
      { kind: 'redirect', location: 'https://h4.example.com/x' },
      { kind: 'redirect', location: 'https://h5.example.com/x' },
      { kind: 'redirect', location: 'https://h6.example.com/x' },
    ])
    await expect(guardedFetch('https://cdn.example.com/0')).rejects.toThrow(/too many redirects/)
  })

  // (f, boundary) exactly 5 redirects then a 200 RESOLVES (bound is >5, not >=5).
  it('guardedFetch resolves with exactly 5 redirects then a 200 (off-by-one guard)', async () => {
    scriptFetch([
      { kind: 'redirect', location: 'https://h1.example.com/x' },
      { kind: 'redirect', location: 'https://h2.example.com/x' },
      { kind: 'redirect', location: 'https://h3.example.com/x' },
      { kind: 'redirect', location: 'https://h4.example.com/x' },
      { kind: 'redirect', location: 'https://h5.example.com/x' },
      { kind: 'terminal', status: 200, body: 'OK' },
    ])
    const res = await guardedFetch('https://cdn.example.com/0')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(6) // initial + 5 redirect targets
  })

  // (g) relative Location resolution against the current URL.
  it('guardedFetch resolves a relative Location against the current URL', async () => {
    scriptFetch([
      { kind: 'redirect', location: '/next/seg.ts' },
      { kind: 'terminal', status: 200, body: 'OK' },
    ])
    const res = await guardedFetch('https://cdn.example.com/a/b.ts')
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([
      'https://cdn.example.com/a/b.ts',
      'https://cdn.example.com/next/seg.ts',
    ])
  })

  // (h) a 30x with NO location header is returned as-is (not followed).
  it('guardedFetch returns a 30x without a location header as-is', async () => {
    scriptFetch([{ kind: 'redirect', status: 302, location: null }])
    const res = await guardedFetch('https://cdn.example.com/a/seg.ts')
    expect(res.status).toBe(302)
    expect(calls).toHaveLength(1)
  })

  // (i) non-redirect status passthrough (egress only loops on 300-399).
  it('guardedFetch returns a non-redirect error status (404) unchanged', async () => {
    scriptFetch([{ kind: 'terminal', status: 404, body: 'nope' }])
    const res = await guardedFetch('https://cdn.example.com/missing.ts')
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  it('guardedFetch returns a 500 terminal status unchanged', async () => {
    scriptFetch([{ kind: 'terminal', status: 500, body: 'boom' }])
    const res = await guardedFetch('https://cdn.example.com/err.ts')
    expect(res.status).toBe(500)
    expect(calls).toHaveLength(1)
  })

  // A fetch stub that never settles on its own — it only rejects when the
  // composed signal egress() passes in fires. Models a hung upstream.
  function hangingFetch(): void {
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      return new Promise((_resolve, reject) => {
        const s = init?.signal
        if (!s) return // hang forever — the test would time out, proving the bug
        if (s.aborted) return reject(s.reason)
        s.addEventListener('abort', () => reject(s.reason), { once: true })
      })
    }) as typeof globalThis.fetch
  }

  // (j) per-hop deadline: a hung upstream is aborted within hopTimeoutMs
  // instead of pinning the egress loop open forever.
  it('guardedFetch aborts a hung upstream within the per-hop deadline', async () => {
    hangingFetch()
    await expect(
      guardedFetch('https://cdn.example.com/index.m3u8', undefined, { hopTimeoutMs: 25 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(calls).toHaveLength(1)
  })

  // (k) the caller's signal (client disconnect) is composed with the per-hop
  // timer, so an aborted client tears the upstream fetch down immediately.
  it('guardedFetch propagates the caller signal alongside the per-hop deadline', async () => {
    hangingFetch()
    const caller = new AbortController()
    const pending = expect(
      guardedFetch(
        'https://cdn.example.com/index.m3u8',
        { signal: caller.signal },
        { hopTimeoutMs: 60_000 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    caller.abort()
    await pending
    expect(calls).toHaveLength(1)
  })

  // (l) without hopTimeoutMs and without a caller signal, no signal is
  // injected — long-lived byte streams must not pick up a surprise timer.
  it('guardedFetch passes NO signal when neither caller signal nor hop timeout is set', async () => {
    scriptFetch([{ kind: 'terminal', status: 200, body: 'OK' }])
    const res = await guardedFetch('https://cdn.example.com/live.ts')
    expect(res.status).toBe(200)
    expect((calls[0].init as RequestInit).signal).toBeUndefined()
  })
})
