// ffmpeg boot validation.
//
// Runs `ffprobe -version` synchronously at server startup and aborts the
// process if ffmpeg is absent or below the minimum version required for
// HLS Low-Latency features (v6.0, assumed by the M4 transcoder).
//
// §13.4 — required in M1.5, not M4-era.  M1 already calls spawn('ffmpeg')
// in iptvRemux.ts; a missing or out-of-version binary currently fails
// silently at runtime (ENOENT on spawn).

import { execFileSync } from 'node:child_process'

const MIN_MAJOR = 6

// Hard cap on how long we'll wait for ffprobe to respond at boot.
// A hanging or misbehaving ffprobe must not block the server indefinitely.
const FFPROBE_TIMEOUT_MS = 5_000

/**
 * Parse the semver-ish major version from an `ffprobe -version` output.
 *
 * Handles four distinct version string families observed in the wild:
 *
 *   Family 1 — Release (Homebrew, apt, direct download):
 *     "ffprobe version 6.1.1 Copyright ..."
 *     "ffprobe version 8.1 Copyright ..."
 *     → extract semver token, compare major
 *
 *   Family 2 — Git dev build (BtbN nightly, manual git clone):
 *     "ffmpeg version N-12345-gabc123d Copyright ..."
 *     "ffmpeg version 7.1-12-g0857141823 Copyright ..."
 *     → N-prefixed or tag+commits+hash; treat as "recent enough", pass unconditionally
 *
 *   Family 3 — Git master date build (Gyan.dev git master, GitHub Actions nightly):
 *     "ffmpeg version 2026-05-21-git-0857141823 Copyright ..."
 *     → YYYY-MM-DD-git-<hash>; current trunk, pass unconditionally
 *
 *   Family 4 — Package-manager variant with hyphen suffix (Debian, MacPorts, Gyan.dev):
 *     "ffmpeg version 6.0-essentials Copyright ..."
 *     "ffmpeg version 6.1.1-1 Copyright ..."
 *     → strip distro suffix, extract leading semver token, compare major
 *
 * Returns the raw version token string on success (useful for logging), or
 * null when the output does not look like ffprobe/ffmpeg output at all.
 *
 * NOTE: unknown/unrecognised version strings (families 2 and 3, plus
 * anything else that cannot be parsed) are treated as "pass" — the
 * operator is responsible for keeping their custom build up-to-date.
 * We never block on unrecognised format.
 */
export function parseFfprobeVersion(output: string): string | null {
  // ffprobe writes version info to stdout; some builds also write to stderr.
  // We accept either; the first non-empty line that contains "version" wins.
  const firstLine = output.split('\n').find(l => /\bversion\b/i.test(l)) ?? output.split('\n')[0] ?? ''

  // Extract the token immediately following "version ".
  const match = firstLine.match(/\bversion\s+(\S+)/)
  if (!match) return null

  return match[1] ?? null
}

/**
 * Classify a parsed version token and return the major version number, or a
 * sentinel that means "pass unconditionally without a numeric check".
 *
 * Returns:
 *   - A non-negative integer for Release / Package-manager builds (compare ≥ MIN_MAJOR).
 *   - Infinity  for Git-dev / Git-master builds — always passes the version gate.
 *   - null      if the token cannot be classified (caller treats as unknown → pass).
 */
export function classifyVersionToken(token: string): number | null {
  // Family 2: N-<commits>-g<hash>  or  <tag>-<commits>-g<hash>
  // Indicator: contains "-g" followed by hex chars, OR starts with "N-"
  if (/^N-\d/.test(token) || /-g[0-9a-f]{4,}/.test(token)) {
    return Infinity
  }

  // Family 3: YYYY-MM-DD-git-<hash>
  if (/^\d{4}-\d{2}-\d{2}-git-/.test(token)) {
    return Infinity
  }

  // Family 1 / Family 4: starts with a digit — release or package-manager variant.
  // Strip any hyphen-suffixed distro noise ("6.0-essentials" → "6.0", "6.1.1-1" → "6.1.1").
  const semverMatch = token.match(/^(\d+(?:\.\d+)*)/)
  if (semverMatch) {
    const major = parseInt(semverMatch[1]?.split('.')[0] ?? '', 10)
    return Number.isNaN(major) ? null : major
  }

  return null
}

/**
 * Validate that ffmpeg ≥ MIN_MAJOR is available on PATH.
 *
 * Security note: the ffprobe invocation uses execFileSync with a hardcoded
 * argument list (['-version']).  No user-controlled input is ever passed to
 * the child process — there is no injection surface here.
 *
 * On success, logs `[ffmpeg] version=<version> path=<resolved path>`.
 * On failure, prints `[boot] ffmpeg ≥6.0 required; found: <version or missing>`
 * to stderr and throws so the caller can call process.exit(1).
 */
export function validateFfmpegOrExit(): void {
  let output: string
  let ffprobePath: string

  // Resolve the binary path first so we can log it on success.
  // 'which' is diagnostic-only; failure is non-fatal.
  try {
    ffprobePath = execFileSync('which', ['ffprobe'], {
      encoding: 'utf8',
      timeout: FFPROBE_TIMEOUT_MS,
    }).trim()
  } catch {
    ffprobePath = 'ffprobe'
  }

  try {
    // stdio: capture both stdout AND stderr — some ffprobe builds write the
    // version line to stderr rather than stdout (observed in certain static
    // builds and container images).  We combine them and search both.
    output = execFileSync('ffprobe', ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FFPROBE_TIMEOUT_MS,
    })
  } catch (err) {
    // ENOENT → binary not found.
    // Non-zero exit (e.g. some builds exit 1 for `-version`) still gives us
    // captured stdout/stderr on the error object — try to recover from those.
    const spawnErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    if (spawnErr.code === 'ENOENT') {
      process.stderr.write('[boot] ffmpeg ≥6.0 required; found: missing\n')
      throw new Error('ffmpeg not found')
    }
    // Combine whatever was captured; at least one channel should have the version line.
    const captured = (spawnErr.stdout ?? '') + (spawnErr.stderr ?? '')
    if (!captured.trim()) {
      process.stderr.write('[boot] ffmpeg ≥6.0 required; found: missing\n')
      throw new Error('ffmpeg not found')
    }
    output = captured
  }

  const token = parseFfprobeVersion(output)

  if (token === null) {
    // Output present but completely unrecognisable — not an ffprobe binary at all.
    process.stderr.write('[boot] ffmpeg ≥6.0 required; found: missing\n')
    throw new Error('ffmpeg version could not be determined')
  }

  const major = classifyVersionToken(token)

  // Infinity → git dev/master build, passes unconditionally.
  // null     → unknown format, passes with a warning (operator's responsibility).
  if (major === null) {
    console.warn(`[ffmpeg] version=${token} (unrecognised format — assuming current) path=${ffprobePath}`)
    return
  }

  if (major !== Infinity && major < MIN_MAJOR) {
    process.stderr.write(`[boot] ffmpeg ≥6.0 required; found: ${token}\n`)
    throw new Error(`ffmpeg ${token} is below minimum required version 6.0`)
  }

  console.log(`[ffmpeg] version=${token} path=${ffprobePath}`)
}
