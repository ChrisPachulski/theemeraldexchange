import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { parseLimitedJson, type LimitedJsonResult } from './parseLimitedJson.js'

const MAX = 64

// Exercise through a real Hono context so the reader sees genuine Request
// body streams (including the no-body and chunked-without-content-length
// cases) rather than a hand-rolled mock.
function makeApp() {
  const app = new Hono()
  app.post('/parse', async (c) => c.json(await parseLimitedJson(c, MAX)))
  return app
}

async function parse(init: RequestInit & { headers?: Record<string, string> }): Promise<LimitedJsonResult> {
  const res = await makeApp().request('/parse', { method: 'POST', ...init })
  return (await res.json()) as LimitedJsonResult
}

describe('parseLimitedJson', () => {
  it('parses a small JSON body', async () => {
    const r = await parse({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
    expect(r).toEqual({ tooLarge: false, body: { a: 1 } })
  })

  it('rejects up front on an oversized declared Content-Length', async () => {
    const r = await parse({
      headers: { 'content-type': 'application/json', 'content-length': String(MAX + 1) },
      body: '{}',
    })
    expect(r).toEqual({ tooLarge: true, body: null })
  })

  it('rejects a streamed body that crosses the cap (no trustworthy Content-Length)', async () => {
    // A body larger than MAX with a small/absent declared length: the
    // byte-counting loop must still refuse it.
    const big = JSON.stringify({ pad: 'x'.repeat(MAX * 4) })
    const r = await parse({
      headers: { 'content-type': 'application/json' },
      body: big,
    })
    expect(r).toEqual({ tooLarge: true, body: null })
  })

  it('returns body null for malformed JSON', async () => {
    const r = await parse({
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    })
    expect(r).toEqual({ tooLarge: false, body: null })
  })

  it('returns body null when there is no body at all', async () => {
    const r = await parse({})
    expect(r).toEqual({ tooLarge: false, body: null })
  })

  it('accepts a body exactly at the cap (boundary is > maxBytes, not >=)', async () => {
    const payload = JSON.stringify({ p: 'y'.repeat(MAX - JSON.stringify({ p: '' }).length) })
    expect(payload.length).toBe(MAX)
    const r = await parse({
      headers: { 'content-type': 'application/json', 'content-length': String(MAX) },
      body: payload,
    })
    expect(r.tooLarge).toBe(false)
    expect(r.body).toEqual(JSON.parse(payload))
  })
})
