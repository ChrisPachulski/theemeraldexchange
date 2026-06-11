// Minimal structured logger for the backend.
//
// The codebase historically used bare `console.*` with ad-hoc `[tag]`
// prefixes, which makes log levels unfilterable and context unparseable
// (free-text interpolation). This wrapper keeps the human-readable
// `[tag] message` shape that docker logs / journalctl users expect, and
// appends a single JSON object for structured context so `grep` AND
// `jq`-style tooling both work on the same line.
//
//   const log = createLogger('tv-cap')
//   log.info('grab queued', { seriesId, sizeGb })
//   → [tv-cap] grab queued {"seriesId":7,"sizeGb":4.2}
//
// Verbosity is env-controlled via LOG_LEVEL (debug|info|warn|error,
// default info). It is read straight from process.env rather than
// env.ts on purpose: env.ts performs strict boot validation and several
// services import this module at load time — a logger must never be
// able to fail the boot it is trying to observe.
//
// Migration is incremental by design: new code and files being touched
// for other reasons should adopt createLogger; wholesale rewrites of
// untouched files are not required. The pattern is lint-friendly — a
// future `no-console` override can allowlist this module alone.

type Level = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

export type Logger = {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function levelFromEnv(): Level {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase()
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error'
    ? raw
    : 'info'
}

let activeLevel: Level = levelFromEnv()

/** Test seam: override the active level (null restores the env-derived one). */
export function _setLogLevelForTests(level: Level | null): void {
  activeLevel = level ?? levelFromEnv()
}

// console.log (not console.debug/info) for the two lower levels: Node maps
// debug/info to stdout anyway, and some log collectors drop console.debug.
// Lazy dispatch (not captured references) so test spies on console.* see
// the calls.
const SINK: Record<Level, (line: string) => void> = {
  debug: (line) => console.log(line),
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
}

/** JSON.stringify replacer that renders Error values usefully instead of `{}`. */
function errorAwareReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  return value
}

function emit(level: Level, tag: string, message: string, context?: LogContext): void {
  if (RANK[level] < RANK[activeLevel]) return
  const line = `[${tag}] ${message}`
  if (context !== undefined && Object.keys(context).length > 0) {
    let rendered: string
    try {
      rendered = JSON.stringify(context, errorAwareReplacer)
    } catch {
      // Circular / exotic context must never crash the caller.
      rendered = '{"logger_error":"unserializable_context"}'
    }
    SINK[level](`${line} ${rendered}`)
  } else {
    SINK[level](line)
  }
}

/** Create a tagged logger. The tag lands as the `[tag]` line prefix. */
export function createLogger(tag: string): Logger {
  return {
    debug: (message, context) => emit('debug', tag, message, context),
    info: (message, context) => emit('info', tag, message, context),
    warn: (message, context) => emit('warn', tag, message, context),
    error: (message, context) => emit('error', tag, message, context),
  }
}
