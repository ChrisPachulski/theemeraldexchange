#!/usr/bin/env node
// Image-pin staleness guard for docker-compose.yml.
//
// WHY: every third-party image in the compose file is pinned tag@digest for
// reproducibility, which also means nothing ever moves them except a human
// (or dependabot). The cloudflared pin once drifted to an ~18-month-old TAG
// label (while the digest had been bumped separately — see the LOCKSTEP note
// in docker-compose.yml), and nothing flagged it. This script flags any
// Docker Hub pin whose tag's last push is older than MAX_AGE_DAYS.
//
// BEST-EFFORT BY DESIGN: only a CONFIRMED stale tag fails (exit 1). Network
// errors, Docker Hub API changes, rate limits, and non-Hub registries are
// warnings (exit 0) so a Hub blip can never fail CI. It also prints — but
// does not fail on — digest drift (pinned digest != the tag's current
// digest), because lagging a fast-moving tag like postgres:15 is the whole
// point of digest pinning.
//
// Usage:
//   node scripts/check-image-pin-staleness.mjs [compose-file]   (default docker-compose.yml)
//   node scripts/check-image-pin-staleness.mjs --self-test      (offline parser assertions)

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

export const MAX_AGE_DAYS = 365

/**
 * Extract `image: repo:tag@sha256:…` pins from compose-file text.
 * Untagged / un-digested images are ignored — the pin policy is enforced by
 * review; this guard only ages the pins that exist.
 */
export function parseImagePins(composeText) {
  const pins = []
  const re =
    /^\s*image:\s*"?([a-z0-9][a-z0-9._/-]*?):([A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})"?\s*(?:#.*)?$/gm
  for (const m of composeText.matchAll(re)) {
    pins.push({ repo: m[1], tag: m[2], digest: m[3] })
  }
  return pins
}

/**
 * Map a compose image repo to its Docker Hub API repository path, or null
 * when the image lives on another registry (ghcr.io/…, lscr.io/…) — those
 * are skipped, not failed.
 */
export function hubRepoPath(repo) {
  const parts = repo.split('/')
  if (parts.length === 1) return `library/${repo}` // official image
  // A first component containing a dot or port is a registry hostname.
  if (parts[0].includes('.') || parts[0].includes(':')) return null
  return repo
}

export function ageDays(isoDate, now = new Date()) {
  return (now.getTime() - new Date(isoDate).getTime()) / 86_400_000
}

async function checkPins(composeFile) {
  const pins = parseImagePins(readFileSync(composeFile, 'utf8'))
  if (pins.length === 0) {
    console.warn(`[pin-staleness] WARN: no tag@digest image pins found in ${composeFile} — parser drift?`)
    return 0
  }
  let stale = 0
  for (const { repo, tag, digest } of pins) {
    const hubPath = hubRepoPath(repo)
    if (!hubPath) {
      console.log(`[pin-staleness] skip ${repo}:${tag} (not a Docker Hub image)`)
      continue
    }
    let info
    try {
      const res = await fetch(
        `https://hub.docker.com/v2/repositories/${hubPath}/tags/${encodeURIComponent(tag)}`,
        { signal: AbortSignal.timeout(15_000) },
      )
      if (!res.ok) {
        console.warn(`[pin-staleness] WARN: Hub API ${res.status} for ${hubPath}:${tag} — skipping (best-effort)`)
        continue
      }
      info = await res.json()
    } catch (err) {
      console.warn(`[pin-staleness] WARN: could not query Hub for ${hubPath}:${tag} (${err}) — skipping (best-effort)`)
      continue
    }
    if (!info?.last_updated) {
      console.warn(`[pin-staleness] WARN: no last_updated in Hub response for ${hubPath}:${tag} — skipping`)
      continue
    }
    const age = Math.round(ageDays(info.last_updated))
    if (age > MAX_AGE_DAYS) {
      stale += 1
      console.error(
        `[pin-staleness] STALE: ${repo}:${tag} — tag last pushed ${age} days ago (> ${MAX_AGE_DAYS}). ` +
          `Bump the tag AND digest together (see the LOCKSTEP note in docker-compose.yml).`,
      )
    } else {
      console.log(`[pin-staleness] ok: ${repo}:${tag} (tag pushed ${age} days ago)`)
    }
    if (info.digest && info.digest !== digest) {
      // Informational only — an intentionally-lagged digest is the pin policy.
      console.log(
        `[pin-staleness] note: ${repo}:${tag} pinned digest lags the tag's current digest (${info.digest.slice(0, 19)}…)`,
      )
    }
  }
  return stale
}

function selfTest() {
  const fixture = `
services:
  a:
    image: cloudflare/cloudflared:2026.6.0@sha256:${'a'.repeat(64)}
  b:
    image: postgres:15@sha256:${'b'.repeat(64)}
  c:
    image: "redis:7-alpine@sha256:${'c'.repeat(64)}"
  d:
    image: ghcr.io/example/thing:1.2@sha256:${'d'.repeat(64)}
  e:
    image: untagged/no-digest:latest
  f:
    image: theemeraldexchange-backend:latest
`
  const pins = parseImagePins(fixture)
  assert.equal(pins.length, 4, `expected 4 pins, got ${pins.length}`)
  assert.deepEqual(pins[0], {
    repo: 'cloudflare/cloudflared',
    tag: '2026.6.0',
    digest: `sha256:${'a'.repeat(64)}`,
  })
  assert.equal(pins[1].repo, 'postgres')
  assert.equal(pins[2].tag, '7-alpine')
  assert.equal(hubRepoPath('postgres'), 'library/postgres')
  assert.equal(hubRepoPath('cloudflare/cloudflared'), 'cloudflare/cloudflared')
  assert.equal(hubRepoPath('ghcr.io/example/thing'), null)
  assert.equal(hubRepoPath('localhost:5000/x'), null)
  assert.ok(ageDays('2020-01-01T00:00:00Z', new Date('2026-01-01T00:00:00Z')) > MAX_AGE_DAYS)
  assert.ok(ageDays('2025-12-01T00:00:00Z', new Date('2026-01-01T00:00:00Z')) < MAX_AGE_DAYS)
  console.log('[pin-staleness] self-test OK (parser + repo-path + age math)')
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  if (process.argv.includes('--self-test')) {
    selfTest()
  } else {
    const composeFile = process.argv[2] ?? 'docker-compose.yml'
    const stale = await checkPins(composeFile)
    if (stale > 0) {
      console.error(`[pin-staleness] ${stale} stale pin(s) found`)
      process.exit(1)
    }
    console.log('[pin-staleness] all checked pins are fresh enough')
  }
}
