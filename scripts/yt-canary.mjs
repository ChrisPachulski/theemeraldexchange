#!/usr/bin/env node
// Weekly upkeep for the native Rust YouTube extractor (crates/ytresolve).
//
// A YouTube extractor rots: Google ships new app builds and the Innertube client
// identity (clientVersion / userAgent / osVersion) drifts, and eventually the
// extraction itself breaks. yt-dlp survives this with a full-time community. This
// is our scaled-down stand-in for that community — run weekly (cron or the
// .github/workflows/yt-canary.yml schedule):
//
//   1. DRIFT CHECK  — compare our clients.json iOS client identity against
//                     yt-dlp's upstream INNERTUBE_CLIENTS (the canonical, always-
//                     current source). `--fix` rewrites clients.json to match.
//   2. LIVE CHECK   — run the actual eex-ytresolve binary against stable public
//                     video ids and assert it still yields a playable stream.
//
// Exit non-zero if the live check fails or (without --fix) drift is detected, so
// CI/cron raises an alarm. With --fix it self-heals the drift and re-tests.
//
// ponytail: node, not a new tool — it already does fetch + JSON + child_process,
// which is the whole job. No deps.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

const FIX = process.argv.includes('--fix')
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENTS_PATH = pathResolve(ROOT, 'crates/ytresolve/clients.json')
const YTDLP_BASE =
  'https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py'
// Stable, long-lived public uploads (studio/official) — good proxies for the
// movie-trailer content the resolver actually serves. If YouTube removes one,
// swap it; the canary passing on ANY one id is enough.
const CANARY_IDS = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', 'jNQXAC9IVRw']

const log = (...a) => console.log(...a)
const fail = (msg) => {
  console.error(`\n✗ CANARY FAIL: ${msg}`)
  process.exit(1)
}

// Pull the iOS client identity fields out of yt-dlp's INNERTUBE_CLIENTS. The
// block is Python-dict source; we read the fields with anchored regexes rather
// than a Python parser (good enough, and exactly what we re-check weekly).
function field(block, key) {
  const m = block.match(new RegExp(`'${key}'\\s*:\\s*'([^']*)'`))
  return m ? m[1] : null
}

async function fetchUpstreamIos() {
  const res = await fetch(YTDLP_BASE)
  if (!res.ok) fail(`could not fetch yt-dlp _base.py (HTTP ${res.status})`)
  const src = await res.text()
  // Isolate the 'ios' client block: from "'ios': {" to the matching context end.
  // We grab a generous window and read fields out of it.
  const start = src.indexOf("'ios': {")
  if (start < 0) fail("yt-dlp _base.py has no 'ios' client block (format changed)")
  const block = src.slice(start, start + 1200)
  const ios = {
    clientVersion: field(block, 'clientVersion'),
    deviceModel: field(block, 'deviceModel'),
    osName: field(block, 'osName'),
    osVersion: field(block, 'osVersion'),
    userAgent: field(block, 'userAgent'),
  }
  if (!ios.clientVersion) fail('could not read iOS clientVersion from upstream')
  return ios
}

function readClients() {
  return JSON.parse(readFileSync(CLIENTS_PATH, 'utf8'))
}

function liveCheck() {
  // Prefer release, fall back to debug — whichever was built.
  const bins = ['target/release/eex-ytresolve', 'target/debug/eex-ytresolve'].map((p) =>
    pathResolve(ROOT, p),
  )
  let lastErr = ''
  for (const id of CANARY_IDS) {
    for (const bin of bins) {
      try {
        const out = execFileSync(bin, [id], { encoding: 'utf8', timeout: 20000 })
        const j = JSON.parse(out)
        const playable = j.hls || j.progressive || (j.video && j.audio)
        if (playable) {
          log(
            `  live: ${id} OK — hls=${!!j.hls} prog=${!!j.progressive} v=${j.video?.height || '-'} a=${!!j.audio}`,
          )
          return true
        }
        lastErr = `${id}: resolved but no playable stream`
      } catch (e) {
        lastErr = `${id}: ${String(e.message || e).split('\n')[0]}`
      }
    }
  }
  fail(`live resolution failed for all canary ids — extractor likely broken. Last: ${lastErr}`)
}

const upstream = await fetchUpstreamIos()
const clients = readClients()
const ours = clients.ios

log('iOS client identity:')
log(`  ours:     ${ours.clientVersion}  (${ours.osVersion})`)
log(`  upstream: ${upstream.clientVersion}  (${upstream.osVersion})`)

const drift =
  ours.clientVersion !== upstream.clientVersion ||
  ours.userAgent !== upstream.userAgent ||
  ours.osVersion !== upstream.osVersion ||
  ours.deviceModel !== upstream.deviceModel

if (drift) {
  if (FIX) {
    Object.assign(clients.ios, {
      clientVersion: upstream.clientVersion,
      deviceModel: upstream.deviceModel ?? ours.deviceModel,
      osName: upstream.osName ?? ours.osName,
      osVersion: upstream.osVersion ?? ours.osVersion,
      userAgent: upstream.userAgent ?? ours.userAgent,
    })
    writeFileSync(CLIENTS_PATH, JSON.stringify(clients, null, 2) + '\n')
    log(`\n→ clients.json synced to upstream iOS ${upstream.clientVersion}. Rebuild + redeploy.`)
  } else {
    log('\n⚠ DRIFT: clients.json lags yt-dlp upstream. Run `node scripts/yt-canary.mjs --fix`.')
  }
} else {
  log('  (in sync)')
}

log('\nLive resolution check:')
liveCheck()

if (drift && !FIX) fail('client identity drift detected (re-run with --fix to sync)')
log('\n✓ canary passed')
