import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Guard test for the third-party license notice. vitest runs with the repo
// root as cwd, so process.cwd() resolves to the repo root.
//
// WHY THIS EXISTS: the shipped server/media-core/transcoder images bundle a
// GPL-3.0+ static ffmpeg (compiled --enable-gpl with libx264/libx265). Conveying
// that binary obligates the project to ship the GPL license text + a written
// offer of corresponding source. THIRD-PARTY-LICENSES.md is that artifact. This
// test prevents the notice from silently disappearing or drifting out of sync
// with the Dockerfiles that introduce the GPL dependency.

const root = process.cwd()
const noticePath = join(root, 'THIRD-PARTY-LICENSES.md')

describe('third-party license notice', () => {
  it('exists at the repo root', () => {
    expect(existsSync(noticePath)).toBe(true)
  })

  it('documents the required GPL ffmpeg facts and the written offer', () => {
    const notice = readFileSync(noticePath, 'utf8')
    const required = [
      'GPL-3.0',
      'libx264',
      'libx265',
      'mwader/static-ffmpeg:7.1',
      'written offer',
      'corresponding source',
      'https://www.gnu.org/licenses/gpl-3.0.txt',
    ]
    for (const token of required) {
      expect(notice, `THIRD-PARTY-LICENSES.md must contain "${token}"`).toContain(token)
    }
  })

  it('stays in sync with every Dockerfile that bundles the GPL static ffmpeg', () => {
    // Anti-drift guard: if a Dockerfile still copies the GPL static ffmpeg, the
    // notice MUST still document the pinned upstream image tag. If someone adds a
    // GPL ffmpeg copy without a matching notice — or removes the notice while a
    // copy remains — this fails loudly. A removed/relocated crate Dockerfile is
    // tolerated (skipped) so the test does not go red on unrelated refactors.
    const dockerfiles = [
      join(root, 'Dockerfile'),
      join(root, 'crates/media-core/Dockerfile'),
      join(root, 'crates/transcoder/Dockerfile'),
    ]
    const notice = readFileSync(noticePath, 'utf8')

    for (const p of dockerfiles) {
      if (!existsSync(p)) continue
      const dockerfile = readFileSync(p, 'utf8')
      if (dockerfile.includes('mwader/static-ffmpeg')) {
        expect(
          notice,
          `${p} bundles the GPL static ffmpeg, so THIRD-PARTY-LICENSES.md must document the upstream image tag "mwader/static-ffmpeg:7.1"`,
        ).toContain('mwader/static-ffmpeg:7.1')
      }
    }
  })
})
