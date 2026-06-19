// Unit tests for the ytmux chunked range-fetcher — the non-trivial loop logic
// that pulls a googlevideo stream down in sub-cap `&range=` windows (a single
// open-ended GET is 403'd). ffmpeg muxing is a thin shell-out (not unit-tested,
// same as ytdlp.ts); the proven-by-hand pipeline lives in the resolver repo.

import { describe, it, expect, vi } from 'vitest'
import { fetchRanged } from './ytmux.js'

const CHUNK = 1_048_576

// A fake fetch that serves windows out of `data` based on the `range=a-b` query,
// mimicking googlevideo: returns exactly the requested window (short at EOF).
function serverFor(data: Buffer) {
  return vi.fn(async (u: string) => {
    const m = /[?&]range=(\d+)-(\d+)/.exec(u)
    if (!m) throw new Error('no range param appended')
    const start = Number(m[1])
    const end = Number(m[2])
    const slice = data.subarray(start, Math.min(end + 1, data.length))
    return {
      status: start < data.length ? 200 : 200,
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    } as Response
  })
}

describe('fetchRanged', () => {
  it('stitches multiple sub-cap windows back into the full stream', async () => {
    const data = Buffer.alloc(CHUNK + 524_288) // 1.5 MiB → 2 windows
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff
    const fake = serverFor(data)

    const out = await fetchRanged('https://gv/video?x=1', fake as unknown as typeof fetch)

    expect(out.length).toBe(data.length)
    expect(out.equals(data)).toBe(true)
    expect(fake).toHaveBeenCalledTimes(2) // full window, then a short read → stop
    // range= is appended with & because the URL already has a query.
    expect(fake.mock.calls[0][0]).toContain('&range=0-')
  })

  it('handles a stream smaller than one window in a single request', async () => {
    const data = Buffer.alloc(1000, 7)
    const fake = serverFor(data)
    const out = await fetchRanged('https://gv/audio', fake as unknown as typeof fetch)
    expect(out.length).toBe(1000)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(fake.mock.calls[0][0]).toContain('?range=0-') // no prior query → ?
  })

  it('throws on a non-2xx status (e.g. expired/over-cap → 403)', async () => {
    const fake = vi.fn(async () => ({ status: 403, arrayBuffer: async () => new ArrayBuffer(0) }) as Response)
    await expect(fetchRanged('https://gv/x', fake as unknown as typeof fetch)).rejects.toThrow(/403/)
  })
})
