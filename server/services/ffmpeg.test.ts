import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const execFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import { parseFfprobeVersion, classifyVersionToken, validateFfmpegOrExit } from './ffmpeg.js'

// ---------------------------------------------------------------------------
// parseFfprobeVersion
// ---------------------------------------------------------------------------

describe('parseFfprobeVersion', () => {
  it('family 1 — extracts semver token from release build stdout', () => {
    const out = 'ffprobe version 6.1.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with gcc 13'
    expect(parseFfprobeVersion(out)).toBe('6.1.1')
  })

  it('family 1 — two-part semver (major.minor only)', () => {
    const out = 'ffprobe version 7.0 Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('7.0')
  })

  it('family 2 — N-prefixed git dev build', () => {
    const out = 'ffmpeg version N-12345-gabc123d Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('N-12345-gabc123d')
  })

  it('family 2 — tag+commits+hash git dev build', () => {
    const out = 'ffmpeg version 7.1-12-g0857141823 Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('7.1-12-g0857141823')
  })

  it('family 3 — date-based git master build', () => {
    const out = 'ffmpeg version 2026-05-21-git-0857141823 Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('2026-05-21-git-0857141823')
  })

  it('family 4 — package-manager build with essentials suffix', () => {
    const out = 'ffmpeg version 6.0-essentials Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('6.0-essentials')
  })

  it('family 4 — Debian/Ubuntu apt build with distro revision', () => {
    const out = 'ffmpeg version 6.1.1-1 Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('6.1.1-1')
  })

  it('version info on stderr-only output (some static builds)', () => {
    // Simulate stderr being prepended/appended as a combined string
    const out = 'ffprobe version 6.0 Copyright (c) 2000-2024 the FFmpeg developers'
    expect(parseFfprobeVersion(out)).toBe('6.0')
  })

  it('returns null for completely unrecognisable output', () => {
    expect(parseFfprobeVersion('not an ffmpeg binary')).toBeNull()
    expect(parseFfprobeVersion('')).toBeNull()
  })

  it('handles malformed / partial version line gracefully — passes (returns token)', () => {
    // Unknown format that starts with "version" but has strange token:
    // We still return the raw token; classifyVersionToken will handle it.
    const out = 'ffmpeg version CUSTOM_BUILD_XYZ_special Copyright ...'
    expect(parseFfprobeVersion(out)).toBe('CUSTOM_BUILD_XYZ_special')
  })
})

// ---------------------------------------------------------------------------
// classifyVersionToken
// ---------------------------------------------------------------------------

describe('classifyVersionToken', () => {
  // Family 1 — Release
  it('returns 6 for "6.1.1"', () => {
    expect(classifyVersionToken('6.1.1')).toBe(6)
  })

  it('returns 7 for "7.0"', () => {
    expect(classifyVersionToken('7.0')).toBe(7)
  })

  it('returns 5 for "5.1.4" (below minimum)', () => {
    expect(classifyVersionToken('5.1.4')).toBe(5)
  })

  // Family 2 — Git dev (N-prefixed or tag+commits+hash) → Infinity
  it('returns Infinity for N-prefixed git dev build', () => {
    expect(classifyVersionToken('N-12345-gabc123d')).toBe(Infinity)
  })

  it('returns Infinity for tag+commits+hash git dev build', () => {
    expect(classifyVersionToken('7.1-12-g0857141823')).toBe(Infinity)
  })

  // Family 3 — Git master date build → Infinity
  it('returns Infinity for date-based git master build', () => {
    expect(classifyVersionToken('2026-05-21-git-0857141823')).toBe(Infinity)
  })

  // Family 4 — Package-manager variant
  it('returns 6 for "6.0-essentials" (strips hyphen suffix)', () => {
    expect(classifyVersionToken('6.0-essentials')).toBe(6)
  })

  it('returns 6 for "6.1.1-1" (strips Debian revision)', () => {
    expect(classifyVersionToken('6.1.1-1')).toBe(6)
  })

  it('returns 6 for "6.0-full"', () => {
    expect(classifyVersionToken('6.0-full')).toBe(6)
  })

  // Unknown / malformed — null
  it('returns null for completely unknown token', () => {
    expect(classifyVersionToken('CUSTOM_BUILD_XYZ')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(classifyVersionToken('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration: parseFfprobeVersion + classifyVersionToken pass/fail outcomes
// ---------------------------------------------------------------------------

describe('version gate integration', () => {
  function shouldPass(output: string): boolean {
    const token = parseFfprobeVersion(output)
    if (token === null) return false
    const major = classifyVersionToken(token)
    if (major === null) return true   // unknown → pass (operator's responsibility)
    if (major === Infinity) return true
    return major >= 6
  }

  it('family 1 release ≥6 → pass', () => {
    expect(shouldPass('ffprobe version 6.1.1 Copyright ...')).toBe(true)
    expect(shouldPass('ffprobe version 8.1 Copyright ...')).toBe(true)
  })

  it('family 1 release <6 → fail', () => {
    expect(shouldPass('ffprobe version 5.1.4 Copyright ...')).toBe(false)
    expect(shouldPass('ffprobe version 4.4.2 Copyright ...')).toBe(false)
  })

  it('family 2 git dev build → pass (treat as recent)', () => {
    expect(shouldPass('ffmpeg version N-12345-gabc123d Copyright ...')).toBe(true)
    expect(shouldPass('ffmpeg version 7.1-12-g0857141823 Copyright ...')).toBe(true)
  })

  it('family 3 git master date build → pass (treat as current trunk)', () => {
    expect(shouldPass('ffmpeg version 2026-05-21-git-0857141823 Copyright ...')).toBe(true)
  })

  it('family 4 package-manager variant ≥6 → pass', () => {
    expect(shouldPass('ffmpeg version 6.0-essentials Copyright ...')).toBe(true)
    expect(shouldPass('ffmpeg version 6.1.1-1 Copyright ...')).toBe(true)
  })

  it('family 4 package-manager variant <6 → fail', () => {
    expect(shouldPass('ffmpeg version 5.0-essentials Copyright ...')).toBe(false)
  })

  it('completely unrecognisable output → false (no token to pass)', () => {
    expect(shouldPass('not an ffmpeg binary at all')).toBe(false)
    expect(shouldPass('')).toBe(false)
  })

  it('malformed version token (unknown format) → pass (allow unknown)', () => {
    // CUSTOM_BUILD_XYZ_special does not match any family; classifyVersionToken
    // returns null and we allow it through.
    expect(shouldPass('ffmpeg version CUSTOM_BUILD_XYZ_special Copyright ...')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateFfmpegOrExit — boot-validation orchestration (lines 106-171)
//
// Mocks node:child_process.execFileSync, dispatching on the first arg:
//   'which'   → resolves the binary path (diagnostic-only, non-fatal)
//   'ffprobe' → returns the version string (or throws a spawn error) under test
// ---------------------------------------------------------------------------

describe('validateFfmpegOrExit', () => {
  /** Configure the mock with a given ffprobe `-version` behaviour. */
  function setFfprobe(version: string | (() => string)) {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which') return '/usr/bin/ffprobe\n'
      if (cmd === 'ffprobe') return typeof version === 'function' ? version() : version
      throw new Error(`unexpected cmd: ${cmd}`)
    })
  }

  beforeEach(() => {
    execFileSyncMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a. SUCCESS — release build ≥6 does not throw and logs version + path', () => {
    setFfprobe('ffprobe version 6.1.1 Copyright (c) 2000-2024 the FFmpeg developers')
    expect(() => validateFfmpegOrExit()).not.toThrow()
    const logged = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(logged).toContain('version=6.1.1')
    expect(logged).toContain('path=/usr/bin/ffprobe')
  })

  it('b. SUCCESS — git-dev build (Infinity branch) does not throw', () => {
    setFfprobe('ffmpeg version N-12345-gabc123d Copyright (c) 2000-2024 the FFmpeg developers')
    expect(() => validateFfmpegOrExit()).not.toThrow()
  })

  it('c. SUCCESS — unknown format warns and returns without throwing', () => {
    setFfprobe('ffmpeg version CUSTOM_BUILD_XYZ_special Copyright (c) 2000-2024 the FFmpeg developers')
    expect(() => validateFfmpegOrExit()).not.toThrow()
    const warned = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(warned).toContain('unrecognised format')
  })

  it('d. FAIL — version below minimum throws and writes the version to stderr', () => {
    setFfprobe('ffprobe version 5.1.4 Copyright (c) 2000-2024 the FFmpeg developers')
    expect(() => validateFfmpegOrExit()).toThrow(/below minimum/i)
    const errOut = (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(errOut).toContain('5.1.4')
  })

  it('e. FAIL — ENOENT (binary missing) throws ffmpeg-not-found and writes "missing"', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which') return '/usr/bin/ffprobe\n'
      if (cmd === 'ffprobe') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(() => validateFfmpegOrExit()).toThrow(/ffmpeg not found/)
    const errOut = (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(errOut).toContain('missing')
  })

  it('f. RECOVERY — non-ENOENT spawn error with captured stdout recovers the version', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which') return '/usr/bin/ffprobe\n'
      if (cmd === 'ffprobe') {
        throw Object.assign(new Error('exit 1'), {
          stdout: 'ffprobe version 6.0 Copyright (c) 2000-2024 the FFmpeg developers',
        })
      }
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(() => validateFfmpegOrExit()).not.toThrow()
  })

  it('g. FAIL — non-ENOENT spawn error with empty captured output throws "missing"', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which') return '/usr/bin/ffprobe\n'
      if (cmd === 'ffprobe') throw Object.assign(new Error('exit 1'), { stdout: '', stderr: '' })
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(() => validateFfmpegOrExit()).toThrow(/ffmpeg not found/)
    const errOut = (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(errOut).toContain('missing')
  })

  it('h. FAIL — output present but unrecognisable (token null) throws "could not be determined"', () => {
    setFfprobe('this is not ffprobe output')
    expect(() => validateFfmpegOrExit()).toThrow(/could not be determined/)
    const errOut = (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(errOut).toContain('missing')
  })

  it('i. "which" failure is non-fatal — falls back to path=ffprobe and does not throw', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which') throw new Error('which not available')
      if (cmd === 'ffprobe') return 'ffprobe version 6.1.1 Copyright (c) 2000-2024 the FFmpeg developers'
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(() => validateFfmpegOrExit()).not.toThrow()
    const logged = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ')
    expect(logged).toContain('path=ffprobe')
  })
})
