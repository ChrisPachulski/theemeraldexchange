// Writes the rewriteRemuxManifest goldens the Rust remux_map tests must match
// byte for byte, from the TS stack. Run from the repo root while the TS IPTV
// code still exists (it goes at S8):
//   npx tsx crates/iptv/tests/fixtures/gen-remux-goldens.ts
// The cases are the iptvLiveRemuxMap.test.ts rewrite cases. The real signer
// embeds a random jti, so each distinct token is replaced by
// encodeURIComponent(`TOK(<rid>#<n>)`), n counting sign calls in a case; the
// Rust test signs with the same deterministic stand-in.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_ENV } from '../../../../vitest.env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
Object.assign(process.env, TEST_ENV)
const { rewriteRemuxManifest, _resetLiveRemuxIndexForTests } = await import(
  '../../../../server/services/iptvLiveRemuxMap.js'
)
const { verifyStreamToken } = await import('../../../../server/services/iptvStreamToken.js')

type Call = { text: string; streamId: string; sessionId: string; sub: string; cache: string | null }

const cold = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:3',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:2.069000,',
  'seg_00000.ts',
  '#EXTINF:2.502000,',
  'seg_00001.ts',
  '',
].join('\n')
const mid = [
  '#EXTM3U',
  '#EXT-X-MEDIA-SEQUENCE:10',
  '#EXTINF:2.0,',
  'seg_00010.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:2.0,',
  'seg_00011.ts',
  '',
].join('\n')
const window = (mediaSeq: number, first: number, count: number): string => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:3', `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`]
  for (let i = 0; i < count; i++) lines.push('#EXTINF:2.0,', `seg_${String(first + i).padStart(5, '0')}.ts`)
  return lines.join('\n') + '\n'
}
const c = (text: string, streamId: string, sessionId: string, sub: string, cache: string | null = null): Call =>
  ({ text, streamId, sessionId, sub, cache })

const cases: Record<string, Call[]> = {
  drops_the_pre_segment_discontinuity: [c(cold, '42', 'sess', 'subA')],
  stable_seg_urls_across_polls: [
    c(cold, '42', 'sess', 'subA', 'a'),
    c(cold, '42', 'sess', 'subA', 'a'),
    c(cold, '42', 'sess', 'subA'),
    c(cold, '42', 'sess', 'subA'),
  ],
  prunes_rolled_off_segments: [
    c('#EXTINF:2.0,\nseg_00000.ts\n#EXTINF:2.0,\nseg_00001.ts\n', '42', 'sess', 'subA', 'a'),
    c('#EXTINF:2.0,\nseg_00001.ts\n#EXTINF:2.0,\nseg_00002.ts\n', '42', 'sess', 'subA', 'a'),
  ],
  keeps_a_mid_stream_discontinuity: [c(mid, '42', 'sess', 'subA')],
  passes_through_unknown_lines: [c('#EXTINF:2.0,\nseg_00000.ts\nnot-a-segment.bin\n', '7', 's', 'u')],
  steady_state: [c(window(10, 10, 3), '42', 'sess-A', 'subZ'), c(window(11, 11, 3), '42', 'sess-A', 'subZ')],
  swap_continuity: [
    c(window(12, 12, 3), '42', 'sess-A', 'subZ'),
    c(window(0, 0, 3), '42', 'sess-B', 'subZ'),
    c(window(1, 1, 3), '42', 'sess-B', 'subZ'),
  ],
  // Defensive path: no MEDIA-SEQUENCE header, so the swap's header is
  // emitted before the first segment.
  swap_without_a_sequence_header: [
    c(window(5, 5, 2), '9', 'sess-A', 'u'),
    c('#EXTM3U\n#EXTINF:2.0,\nseg_00000.ts\r\n#EXTINF:2.0,\nseg_00001.ts\n', '9', 'sess-B', 'u'),
  ],
}

const out: Record<string, Array<Call & { out: string; cacheKeys: string[] | null }>> = {}
for (const [name, calls] of Object.entries(cases)) {
  _resetLiveRemuxIndexForTests()
  const caches = new Map<string, Map<string, string>>()
  const names = new Map<string, string>()
  out[name] = calls.map((call) => {
    const cache = call.cache ? (caches.get(call.cache) ?? caches.set(call.cache, new Map()).get(call.cache)!) : undefined
    let text = rewriteRemuxManifest(call.text, call.streamId, call.sessionId, call.sub, cache)
    text = text.replace(/\?t=([^\n]+)/g, (_m, enc: string) => {
      const token = decodeURIComponent(enc)
      if (!names.has(token)) {
        const claims = verifyStreamToken(process.env.STREAM_TOKEN_SECRET!, token)
        if (claims.k !== 'remux' || claims.sub !== call.sub) throw new Error('unexpected claims')
        names.set(token, `TOK(${claims.rid}#${names.size + 1})`)
      }
      return '?t=' + encodeURIComponent(names.get(token)!)
    })
    return { ...call, out: text, cacheKeys: cache ? [...cache.keys()].sort() : null }
  })
}
fs.writeFileSync(path.join(here, 'remux-goldens.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote remux-goldens.json:', Object.keys(out).length, 'cases')
