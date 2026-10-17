// Writes the compareFingerprints goldens the Rust fingerprint tests must match
// (score within 1e-6, offset and overlap exactly), from the TS stack. Run from
// the repo root while the TS IPTV code still exists (it goes at S8):
//   npx tsx crates/iptv/tests/fixtures/gen-fingerprint-goldens.ts
// The frames are the synthetic broadcasts of iptvFeedFingerprint.test.ts,
// iptvFeedVerify.test.ts and iptvFeedSweep.test.ts. They are not stored: the
// Rust test regenerates them with the same PRNG and checks each frame buffer's
// sha256 against the one recorded here, so both sides score the same bytes.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_ENV } from '../../../../vitest.env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
Object.assign(process.env, TEST_ENV)
const { compareFingerprints, FP_FRAME_BYTES } = await import('../../../../server/services/iptvFeedFingerprint.js')

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// iptvFeedFingerprint.test.ts: scenes with per-frame noise.
function noisy(seed: number, frames: number): Uint8Array {
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

function otherSource(src: Uint8Array, start: number, count: number, seed: number): Uint8Array {
  const r = rng(seed)
  const out = new Uint8Array(count * FP_FRAME_BYTES)
  for (let i = 0; i < out.length; i++) {
    const v = src[start * FP_FRAME_BYTES + i] * 0.85 + 12 + (r() - 0.5) * 12
    out[i] = Math.max(0, Math.min(255, Math.round(v)))
  }
  return out
}

// iptvFeedVerify.test.ts: held scenes, no noise.
function plain(seed: number, frames = 300): Uint8Array {
  const r = rng(seed)
  const out = new Uint8Array(frames * FP_FRAME_BYTES)
  let scene = new Uint8Array(FP_FRAME_BYTES)
  for (let f = 0; f < frames; f++) {
    if (f % 12 === 0) scene = Uint8Array.from({ length: FP_FRAME_BYTES }, () => Math.floor(r() * 256))
    for (let i = 0; i < FP_FRAME_BYTES; i++) out[f * FP_FRAME_BYTES + i] = scene[i]
  }
  return out
}

function slice(src: Uint8Array, start: number, count = 125): Uint8Array {
  return src.map((v) => Math.round(v * 0.9 + 10)).slice(start * FP_FRAME_BYTES, (start + count) * FP_FRAME_BYTES)
}

// iptvFeedSweep.test.ts.
const SWEEP = Uint8Array.from({ length: 125 * FP_FRAME_BYTES }, (_, i) => {
  const scene = Math.floor(i / (12 * FP_FRAME_BYTES))
  return ((i % FP_FRAME_BYTES) * 37 + scene * 101) % 251
})

const sho1 = plain(1)
const sho2 = plain(2)
const blend = sho1.map((v, i) => Math.round((v + sho2[i]) / 2))
const noisy1 = noisy(1, 300)
const noisy4 = noisy(4, 300)
const cases: Array<[string, Uint8Array, Uint8Array]> = [
  ['noisy1 vs other source at 140', noisy1, otherSource(noisy1, 140, 125, 7)],
  ['noisy1 vs noisy2', noisy1, noisy(2, 125)],
  ['black vs noisy3', new Uint8Array(300 * FP_FRAME_BYTES).fill(16), noisy(3, 125)],
  ['noisy4 vs 30 frames', noisy4, otherSource(noisy4, 10, 30, 5)],
  ['sho1 vs slice sho1 140', sho1, slice(sho1, 140)],
  ['sho2 vs slice sho1 140', sho2, slice(sho1, 140)],
  ['sho2 vs slice sho2 140', sho2, slice(sho2, 140)],
  ['blend vs slice sho1 140', blend, slice(sho1, 140)],
  ['slice sho2 130 vs slice sho2 140', slice(sho2, 130), slice(sho2, 140)],
  ['sweep broadcast vs itself', SWEEP, SWEEP],
]

const sha = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex')
const out = cases.map(([name, a, b]) => ({ name, a: sha(a), b: sha(b), match: compareFingerprints(a, b) }))
fs.writeFileSync(path.join(here, 'fingerprint-goldens.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`wrote ${out.length} cases`)
