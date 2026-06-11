import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Guard test for the third-party license notice. vitest runs with the repo
// root as cwd, so process.cwd() resolves to the repo root.
//
// WHY THIS EXISTS: the shipped images convey GPL-licensed ffmpeg binaries —
// the server + media-core images bundle a STATIC GPL-3.0+ ffmpeg
// (mwader/static-ffmpeg:7.1, --enable-gpl --enable-version3 with
// libx264/libx265), while the transcoder image installs Debian bookworm's
// DYNAMICALLY-linked GPL-2.0+ ffmpeg via apt (required for VAAPI hardware
// encode). Conveying those binaries obligates the project to ship the GPL
// license texts + a written offer of corresponding source.
// THIRD-PARTY-LICENSES.md is that artifact.
//
// This test is BIDIRECTIONAL and PER-IMAGE: it parses every Dockerfile in the
// repo to determine how (or whether) each image actually provisions ffmpeg,
// parses the notice's per-image table, and asserts the two match exactly. If a
// Dockerfile adds, drops, or switches its ffmpeg provisioning — or the notice
// claims something a Dockerfile does not do — this fails loudly. Nothing about
// the Dockerfiles' contents is hardcoded here, so the check cannot silently rot.

const root = process.cwd()
const noticePath = join(root, 'THIRD-PARTY-LICENSES.md')

// Directories that can never contain first-party Dockerfiles. Hidden dirs
// (.git, .claude, .venv, …) are skipped wholesale below.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'coverage', 'data'])

function findDockerfiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      findDockerfiles(join(dir, entry.name), acc)
    } else if (entry.name === 'Dockerfile') {
      acc.push(join(dir, entry.name))
    }
  }
  return acc
}

type Provisioning = 'static' | 'debian' | 'none'

const STATIC_FFMPEG_IMAGE = 'mwader/static-ffmpeg'
const STATIC_FFMPEG_PINNED = 'mwader/static-ffmpeg:7.1'

/**
 * Determine how a Dockerfile provisions ffmpeg by parsing its instructions:
 *  - 'static': COPYs binaries from the mwader/static-ffmpeg image (GPL-3.0+).
 *  - 'debian': installs Debian's `ffmpeg` package via apt-get (GPL-2.0+).
 *  - 'none':   does not ship ffmpeg at all.
 */
function ffmpegProvisioning(dockerfileText: string): Provisioning {
  // Join backslash line-continuations so multi-line RUN/COPY instructions
  // parse as single logical lines, then drop comments/blanks.
  const lines = dockerfileText
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  const copiesStatic = lines.some(
    (l) => /^COPY\b/i.test(l) && l.includes(`--from=${STATIC_FFMPEG_IMAGE}`),
  )

  let installsDebian = false
  for (const line of lines) {
    if (!/^RUN\b/i.test(line)) continue
    // Split the RUN payload into individual shell commands and look for an
    // `apt-get … install … ffmpeg` whose package list names ffmpeg itself
    // (flags excluded). ENV/comments mentioning "ffmpeg" never reach here.
    for (const cmd of line.replace(/^RUN\b/i, '').split(/&&|;/)) {
      const m = cmd.match(/\bapt-get\s+(?:\S+\s+)*?install\b(.*)$/)
      if (!m) continue
      const packages = m[1].split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('-'))
      if (packages.includes('ffmpeg')) installsDebian = true
    }
  }

  if (copiesStatic && installsDebian) {
    throw new Error(
      'Dockerfile both COPYs the static ffmpeg and apt-installs Debian ffmpeg — ' +
        'ambiguous provisioning; fix the Dockerfile or extend this parser.',
    )
  }
  if (copiesStatic) return 'static'
  if (installsDebian) return 'debian'
  return 'none'
}

/**
 * Parse the per-image table in THIRD-PARTY-LICENSES.md. Each data row names a
 * Dockerfile in backticks and describes its ffmpeg provisioning; rows that
 * mention the pinned static image are 'static' claims, rows that mention
 * Debian are 'debian' claims.
 */
function noticeClaims(notice: string): Map<string, Provisioning> {
  const claims = new Map<string, Provisioning>()
  for (const line of notice.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const pathMatch = line.match(/`([^`]*Dockerfile)`/)
    if (!pathMatch) continue
    const dockerfilePath = pathMatch[1]
    if (line.includes(STATIC_FFMPEG_PINNED)) {
      claims.set(dockerfilePath, 'static')
    } else if (/debian/i.test(line)) {
      claims.set(dockerfilePath, 'debian')
    } else {
      throw new Error(
        `THIRD-PARTY-LICENSES.md table row for ${dockerfilePath} has an unrecognized ` +
          `ffmpeg provisioning (expected "${STATIC_FFMPEG_PINNED}" or "Debian"): ${line}`,
      )
    }
  }
  return claims
}

describe('third-party license notice', () => {
  it('exists at the repo root', () => {
    expect(existsSync(noticePath)).toBe(true)
  })

  it('documents the required GPL ffmpeg facts and the written offer', () => {
    const notice = readFileSync(noticePath, 'utf8')
    const required = [
      'GPL-3.0',
      'GPL-2.0',
      'libx264',
      'libx265',
      STATIC_FFMPEG_PINNED,
      'written offer',
      'corresponding source',
      'https://www.gnu.org/licenses/gpl-3.0.txt',
      'https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt',
      'snapshot.debian.org',
    ]
    for (const token of required) {
      expect(notice, `THIRD-PARTY-LICENSES.md must contain "${token}"`).toContain(token)
    }
  })

  it('names a public, durable contact for GPL source requests', () => {
    const notice = readFileSync(noticePath, 'utf8')
    expect(
      notice,
      'the GPL written offer must name a real source-request channel',
    ).toContain('Source requests: https://github.com/ChrisPachulski/theemeraldexchange/issues')
    expect(
      notice,
      'the written offer must not contain an unfilled placeholder contact',
    ).not.toMatch(/<\s*maintainer/i)
  })

  it("stays in sync, bidirectionally, with every Dockerfile's actual ffmpeg provisioning", () => {
    const notice = readFileSync(noticePath, 'utf8')
    const claims = noticeClaims(notice)
    expect(
      claims.size,
      'THIRD-PARTY-LICENSES.md must contain the per-image ffmpeg provisioning table',
    ).toBeGreaterThan(0)

    const actual = new Map<string, Provisioning>()
    for (const abs of findDockerfiles(root)) {
      const rel = relative(root, abs).split(sep).join('/')
      actual.set(rel, ffmpegProvisioning(readFileSync(abs, 'utf8')))
    }
    expect(actual.size, 'expected to discover at least one Dockerfile in the repo').toBeGreaterThan(0)

    // Direction 1: every Dockerfile that ships ffmpeg must be documented, with
    // the CORRECT provisioning. Catches: a new image adding ffmpeg, an image
    // switching static<->debian without a notice update (e.g. the transcoder
    // must never be listed as bundling the static GPL-3 build).
    for (const [rel, provisioning] of actual) {
      if (provisioning === 'none') continue
      expect(
        claims.get(rel),
        `${rel} ships ffmpeg via "${provisioning}" but THIRD-PARTY-LICENSES.md ` +
          `documents it as "${claims.get(rel) ?? 'absent from the table'}" — update the notice table`,
      ).toBe(provisioning)
    }

    // Direction 2: every claim in the notice must correspond to a real
    // Dockerfile that actually does what the notice says. Catches: an image
    // dropping ffmpeg (or being deleted/moved) while the notice still lists
    // it, and stale provisioning claims.
    for (const [rel, claimed] of claims) {
      expect(
        actual.has(rel),
        `THIRD-PARTY-LICENSES.md lists ${rel}, but no such Dockerfile exists — remove or fix the table row`,
      ).toBe(true)
      expect(
        actual.get(rel),
        `THIRD-PARTY-LICENSES.md claims ${rel} provisions ffmpeg via "${claimed}" ` +
          `but the Dockerfile actually does "${actual.get(rel)}" — update the notice table`,
      ).toBe(claimed)
    }
  })

  it('documents every non-registry npm dependency as a supply-chain note', () => {
    // npm records no integrity hash for git-resolved dependencies, so each one
    // is a supply-chain deviation that must be consciously tracked in the
    // notice (currently: webworkify-webpack via mpegts.js, commit-pinned).
    const notice = readFileSync(noticePath, 'utf8')
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { resolved?: string; link?: boolean }>
    }
    for (const [pkgPath, entry] of Object.entries(lock.packages ?? {})) {
      if (pkgPath === '') continue // the root project entry
      const resolved = entry.resolved ?? ''
      // First-party workspace/file links are not third-party supply chain.
      if (entry.link || resolved === '' || resolved.startsWith('file:')) continue
      if (resolved.startsWith('https://registry.npmjs.org/')) continue
      const name = pkgPath.replace(/^.*node_modules\//, '')
      expect(
        notice,
        `${name} resolves from a non-registry URL (${resolved}) — document it in ` +
          "THIRD-PARTY-LICENSES.md's supply-chain section",
      ).toContain(name)
    }
  })
})
