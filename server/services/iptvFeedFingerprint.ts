// Feed fingerprints: tiny grayscale frame sequences that tell whether two live
// streams carry the same picture.
//
// Provider streams carry no channel identity of their own (their MPEG-TS service
// reads "Service01 / FFmpeg"), and a stream can carry a different channel than
// its guide listing: on 2026-10-09 "US: Showtime" carried Showtime 2, so picking
// My Cousin Vinny in the guide played Blade Runner 2049. The picture is the only
// ground truth, so iptvFeedVerify compares a stream's picture with other streams'.
//
// A fingerprint is FP_FPS frames/s of a centre crop (letterbox and pillarbox bars
// cropped away) scaled to FP_W x FP_H luma. Two feeds of one broadcast correlate
// ~0.98+ per frame at the right time offset even across different encodes; a
// different programme scores ~0.3 (measured on prod feeds, 2026-10-09).

export const FP_W = 32
export const FP_H = 18
export const FP_FPS = 5
export const FP_FRAME_BYTES = FP_W * FP_H

/** Frames whose luma spread is below this are black / fades / flat slates: they
 *  say nothing about which programme is on, so they never count toward a score. */
const FLAT_STD = 4

/** At least this many informative frame pairs (8s at 5 fps) must line up before
 *  a score means anything. */
export const MIN_OVERLAP_FRAMES = 40

const FINGERPRINT_VF = `fps=${FP_FPS},crop=iw*0.8:ih*0.6,scale=${FP_W}:${FP_H}:flags=area,format=gray`

// Decoder shortcuts: the picture is scaled to 32x18, so deblocking is wasted
// work on the Plex-sharing NAS. Two threads keeps a capture off every core.
const DECODE_ARGS = ['-skip_loop_filter', 'all', '-threads', '2']

function outputArgs(): string[] {
  return ['-map', '0:v:0', '-an', '-sn', '-dn', '-vf', FINGERPRINT_VF, '-f', 'rawvideo', 'pipe:1']
}

/** ffmpeg argv: `seconds` of a live upstream feed → fingerprint frames on stdout.
 *  Same input hardening as the live remux (protocol whitelist, read timeout, the
 *  User-Agent the provider accepts). */
export function liveCaptureArgs(upstreamUrl: string, seconds: number, userAgent: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-fflags', '+discardcorrupt',
    '-probesize', '10M', '-analyzeduration', '10M',
    '-rw_timeout', '15000000',
    '-user_agent', userAgent,
    ...DECODE_ARGS,
    '-t', String(seconds),
    '-i', upstreamUrl,
    ...outputArgs(),
  ]
}

/** ffmpeg argv: a live session's on-disk remux segments → fingerprint frames. */
export function segmentCaptureArgs(segmentPaths: string[]): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,concat',
    ...DECODE_ARGS,
    '-i', `concat:${segmentPaths.join('|')}`,
    ...outputArgs(),
  ]
}

/** Each frame z-normalised (zero mean, unit variance); null for a flat frame. */
function normaliseFrames(frames: Uint8Array): Array<Float32Array | null> {
  const count = Math.floor(frames.length / FP_FRAME_BYTES)
  const out: Array<Float32Array | null> = []
  for (let f = 0; f < count; f++) {
    const base = f * FP_FRAME_BYTES
    let sum = 0
    for (let i = 0; i < FP_FRAME_BYTES; i++) sum += frames[base + i]
    const mean = sum / FP_FRAME_BYTES
    let sq = 0
    for (let i = 0; i < FP_FRAME_BYTES; i++) {
      const d = frames[base + i] - mean
      sq += d * d
    }
    const std = Math.sqrt(sq / FP_FRAME_BYTES)
    if (std < FLAT_STD) {
      out.push(null)
      continue
    }
    const v = new Float32Array(FP_FRAME_BYTES)
    for (let i = 0; i < FP_FRAME_BYTES; i++) v[i] = (frames[base + i] - mean) / std
    out.push(v)
  }
  return out
}

export interface FingerprintMatch {
  /** Mean per-frame Pearson correlation over the informative aligned frames. */
  score: number
  /** Frames `b` is shifted against `a` at the best alignment. */
  offset: number
  /** Informative frame pairs behind the score. */
  overlap: number
}

/**
 * Best alignment of two fingerprints: slide one over the other, score each
 * offset by the mean correlation of the frame pairs where both frames carry
 * picture, and keep the highest. Null when no offset lines up `minOverlap`
 * informative pairs (too short, or mostly black): that is "can't tell", never a
 * no-match.
 */
export function compareFingerprints(
  a: Uint8Array,
  b: Uint8Array,
  minOverlap: number = MIN_OVERLAP_FRAMES,
): FingerprintMatch | null {
  const na = normaliseFrames(a)
  const nb = normaliseFrames(b)
  let best: FingerprintMatch | null = null
  // b[j] pairs with a[j + offset].
  for (let offset = -(nb.length - 1); offset < na.length; offset++) {
    const lo = Math.max(0, -offset)
    const hi = Math.min(nb.length, na.length - offset)
    if (hi - lo < minOverlap) continue
    let total = 0
    let pairs = 0
    for (let j = lo; j < hi; j++) {
      const va = na[j + offset]
      const vb = nb[j]
      if (!va || !vb) continue
      let dot = 0
      for (let i = 0; i < FP_FRAME_BYTES; i++) dot += va[i] * vb[i]
      total += dot / FP_FRAME_BYTES
      pairs++
    }
    if (pairs < minOverlap) continue
    const score = total / pairs
    if (!best || score > best.score) best = { score, offset, overlap: pairs }
  }
  return best
}
