import { afterAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { env } from '../env.js'
import { publicBaseUrl } from './publicBaseUrl.js'

// Carried over from the former /api/iptv playlist-mint tests; the trailer
// grant (routes/tmdb.ts) is the remaining caller.
const app = new Hono().get('/', (c) => c.text(publicBaseUrl(c)))
const envRw = env as unknown as { allowedOrigins: string[] }
const prevOrigins = envRw.allowedOrigins

async function baseFor(forwardedHost: string): Promise<string> {
  const res = await app.request('http://internal.local:3001/', {
    headers: { host: 'internal.local:3001', 'x-forwarded-proto': 'https', 'x-forwarded-host': forwardedHost },
  })
  return res.text()
}

describe('publicBaseUrl host allowlisting', () => {
  afterAll(() => {
    envRw.allowedOrigins = prevOrigins
  })

  it('accepts a forwarded host that matches an allowed origin exactly', async () => {
    envRw.allowedOrigins = ['https://theemeraldexchange.example']
    expect(await baseFor('theemeraldexchange.example')).toBe('https://theemeraldexchange.example')
  })

  it('accepts a forwarded host that is a subdomain of an allowed origin (api.<spa-domain>)', async () => {
    envRw.allowedOrigins = ['https://theemeraldexchange.example']
    expect(await baseFor('api.theemeraldexchange.example')).toBe('https://api.theemeraldexchange.example')
  })

  it('falls back to the first allowed origin for a forwarded host outside the allowlist', async () => {
    envRw.allowedOrigins = ['https://theemeraldexchange.example']
    for (const evil of ['evil.example.com', 'eviltheemeraldexchange.example', 'theemeraldexchange.example.evil.com']) {
      expect(await baseFor(evil)).toBe('https://theemeraldexchange.example')
    }
  })

  it('passes the forwarded host through when no allowlist is configured (dev)', async () => {
    envRw.allowedOrigins = []
    expect(await baseFor('api.example.com')).toBe('https://api.example.com')
  })
})
