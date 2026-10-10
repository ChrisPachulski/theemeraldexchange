import { describe, expect, it } from 'vitest'
import {
  compareFingerprints,
  FP_FRAME_BYTES,
  liveCaptureArgs,
  segmentCaptureArgs,
} from './iptvFeedFingerprint.js'

/** Deterministic PRNG so a "broadcast" is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** A synthetic broadcast: scenes of random luma images, each held a few frames
 *  with slight motion, like a cut-heavy programme at 5 fps. */
function broadcast(seed: number, frames: number): Uint8Array {
  const r = rng(seed)
  const out = new Uint8Array(frames * FP_FRAME_BYTES)
  let scene = new Uint8Array(FP_FRAME_BYTES)
  for (let f = 0; f < frames; f++) {
    if (f % 12 === 0) scene = Uint8Array.from({ length: FP_FRAME_BYTES }, () => Math.floor(r() * 256))
    for (let i = 0; i < FP_FRAME_BYTES; i++) {
      out[f * FP_FRAME_BYTES + i] = Math.max(0, Math.min(255, scene[i] + Math.floor((r() - 0.5) * 20)))
    }
  }
  return out
}

/** The same broadcast through another source: frames `[start, start+count)`,
 *  dimmer with a lift, plus encode noise. */
function otherSource(src: Uint8Array, start: number, count: number, seed: number): Uint8Array {
  const r = rng(seed)
  const out = new Uint8Array(count * FP_FRAME_BYTES)
  for (let i = 0; i < out.length; i++) {
    const v = src[start * FP_FRAME_BYTES + i] * 0.85 + 12 + (r() - 0.5) * 12
    out[i] = Math.max(0, Math.min(255, Math.round(v)))
  }
  return out
}

describe('compareFingerprints', () => {
  it('matches two sources of one broadcast at their time offset', () => {
    const session = broadcast(1, 300) // 60s of the watched stream
    const candidate = otherSource(session, 140, 125, 7) // 25s of another feed, 28s in
    const m = compareFingerprints(session, candidate)
    expect(m).not.toBeNull()
    expect(m!.score).toBeGreaterThan(0.95)
    expect(m!.offset).toBe(140)
    expect(m!.overlap).toBe(125)
  })

  it('scores a different broadcast low', () => {
    const m = compareFingerprints(broadcast(1, 300), broadcast(2, 125))
    expect(m).not.toBeNull()
    expect(m!.score).toBeLessThan(0.3)
  })

  it('cannot tell when the picture is black', () => {
    const black = new Uint8Array(300 * FP_FRAME_BYTES).fill(16)
    expect(compareFingerprints(black, broadcast(3, 125))).toBeNull()
  })

  it('cannot tell from too little footage', () => {
    const session = broadcast(4, 300)
    expect(compareFingerprints(session, otherSource(session, 10, 30, 5))).toBeNull()
  })
})

describe('capture argv', () => {
  it('reads a bounded slice of the upstream with the provider UA', () => {
    const args = liveCaptureArgs('https://up.example/live/u/p/7.ts', 25, 'UA')
    expect(args[args.indexOf('-user_agent') + 1]).toBe('UA')
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-t') + 1]).toBe('25')
    expect(args[args.indexOf('-i') + 1]).toBe('https://up.example/live/u/p/7.ts')
    expect(args.at(-1)).toBe('pipe:1')
    expect(args[args.indexOf('-protocol_whitelist') + 1]).not.toContain('concat')
  })

  it('concatenates session segments from disk only', () => {
    const args = segmentCaptureArgs(['/tmp/s/seg_00001.ts', '/tmp/s/seg_00002.ts'])
    expect(args[args.indexOf('-i') + 1]).toBe('concat:/tmp/s/seg_00001.ts|/tmp/s/seg_00002.ts')
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,concat')
    expect(args.at(-1)).toBe('pipe:1')
  })
})
