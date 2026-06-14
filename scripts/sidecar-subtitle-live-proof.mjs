#!/usr/bin/env node
// Sidecar-subtitle PUBLIC-PATH proof (CLI half of the fbe9c66 verification).
//
// Drives the real grant orchestrator over the PUBLIC edge
// (laptop -> Cloudflare -> cloudflared -> backend -> media-core -> transcoder)
// and proves the piece that could only ever be checked live: the sidecar
// `subtitles.vtt` is reachable CROSS-ORIGIN at the CF/Node edge with CORS that
// admits the SPA origin (exactly like the HLS segments), it is real WebVTT with
// cues, and the `forced` flag is carried through end to end. The unauthenticated
// fetch is rejected (the asset token gate is live).
//
// The browser half (cues actually PAINT over MSE; the MediaControls CC toggle
// flips them on/off) is a separate Playwright/real-Chrome run — bundled
// chromium lacks H.264/AAC so it can't drive the MSE pipeline.
//
//   EEX_COOKIE='eex.session=...' \
//     node scripts/sidecar-subtitle-live-proof.mjs <movieId> <expectForced:true|false>
//
// The cookie is an owner/admin session minted inside the backend container:
//   docker exec exchange-backend node --import tsx -e \
//     "import('./server/session.ts').then(async m => \
//       console.log('eex.session=' + await m.createSession( \
//         {sub:'plex:494190801',username:'owner',role:'admin',auth_mode:'plex'})))"

const API = process.env.EEX_API ?? 'https://api.theemeraldexchange.com'
const SPA_ORIGIN = process.env.EEX_ORIGIN ?? 'https://theemeraldexchange.com'
const COOKIE = process.env.EEX_COOKIE
const movieId = process.argv[2]
const expectForced = process.argv[3] === 'true'

if (!COOKIE || !movieId) {
  console.error('usage: EEX_COOKIE=eex.session=... node sidecar-subtitle-live-proof.mjs <movieId> <expectForced>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const abs = (u) => (/^https?:\/\//.test(u) ? u : `${API}${u.startsWith('/') ? '' : '/'}${u}`)
let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) failures++ }
const hdr = (s) => console.log(`\n==== ${s} ====`)

// Browser-equivalent headers: the SPA is a different origin from the API, so
// every real request carries Origin (the CSRF gate requires it) + the cookie.
const browserHeaders = { Origin: SPA_ORIGIN, Cookie: COOKIE }

async function main() {
  hdr(`GRANT (public path) movie/${movieId}`)
  const grantRes = await fetch(`${API}/api/media/playback/movie/${movieId}`, {
    method: 'POST',
    headers: { ...browserHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ caps: {} }),
  })
  console.log('grant status:', grantRes.status)
  const grant = await grantRes.json().catch(() => ({}))
  ok(grantRes.status === 200, 'grant returned 200')
  ok(grant.delivery === 'hls', `delivery=hls (got ${grant.delivery}) — transcode path carries a sidecar`)
  ok(grant.subtitle != null, 'grant advertises a sidecar subtitle descriptor')
  if (!grant.subtitle) { return finish(grant) }

  console.log('subtitle descriptor:', JSON.stringify(grant.subtitle))
  ok(grant.subtitle.forced === expectForced, `subtitle.forced === ${expectForced}`)
  ok(typeof grant.subtitle.url === 'string' && grant.subtitle.url.includes('t='),
    'subtitle.url is token-wrapped')

  // Keep the session warm: the transcoder reaps idle sessions in ~30s, which
  // would 404 the .vtt mid-proof and read as a CORS failure.
  if (grant.heartbeatUrl) {
    await fetch(abs(grant.heartbeatUrl), { method: 'POST', headers: browserHeaders }).catch(() => {})
  }

  // Give the detached one-shot ffmpeg sidecar pass a moment to land the file.
  const vttUrl = abs(grant.subtitle.url)
  hdr('SIDECAR .vtt — CROSS-ORIGIN FETCH AT THE EDGE')
  console.log('vtt url:', vttUrl.replace(/t=[^&]+/, 't=<redacted>'))
  let vttRes, body = ''
  for (let i = 0; i < 30; i++) {
    if (grant.heartbeatUrl && i % 6 === 5) {
      await fetch(abs(grant.heartbeatUrl), { method: 'POST', headers: browserHeaders }).catch(() => {})
    }
    vttRes = await fetch(vttUrl, { headers: { Origin: SPA_ORIGIN } }).catch(() => null)
    if (vttRes && vttRes.status === 200) { body = await vttRes.text(); break }
    await sleep(500)
  }
  ok(!!vttRes && vttRes.status === 200, `.vtt fetched 200 cross-origin (got ${vttRes?.status})`)
  if (vttRes) {
    const ct = vttRes.headers.get('content-type') || ''
    const acao = vttRes.headers.get('access-control-allow-origin') || ''
    console.log('content-type:', ct)
    console.log('access-control-allow-origin:', acao)
    ok(/text\/vtt/.test(ct), 'content-type is text/vtt')
    ok(acao === SPA_ORIGIN || acao === '*', `CORS admits the SPA origin (got "${acao}")`)
    ok(/^﻿?WEBVTT/.test(body), '.vtt body starts with the WEBVTT signature')
    const cueCount = (body.match(/-->/g) || []).length
    console.log('cue count:', cueCount)
    ok(cueCount > 0, '.vtt contains at least one cue')
    const firstCue = body.split('\n').find((l) => l.includes('-->'))
    if (firstCue) console.log('first cue timing:', firstCue.trim())
  }

  hdr('NEGATIVE — unauthenticated .vtt fetch must be rejected')
  const noTok = await fetch(vttUrl.replace(/[?&]t=[^&]+/, ''), { headers: { Origin: SPA_ORIGIN } }).catch(() => null)
  console.log('no-token status (expect 401):', noTok?.status)
  ok(noTok != null && (noTok.status === 401 || noTok.status === 403), 'no-token .vtt fetch rejected (401/403)')

  // Free the transcoder slot.
  if (grant.stopUrl) await fetch(abs(grant.stopUrl), { method: 'POST', headers: browserHeaders }).catch(() => {})
  finish(grant)
}

function finish() {
  hdr(failures === 0 ? 'PASS — sidecar .vtt is live cross-origin on the public path' : `FAIL — ${failures} assertion(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
