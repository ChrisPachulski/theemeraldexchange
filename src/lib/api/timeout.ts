// Shared fetch-timeout plumbing for the API clients (media.ts, iptv.ts). A
// stalled backend must not pin a query in 'pending' forever — abort and surface
// a clear error instead of an endless spinner.
const DEFAULT_TIMEOUT_MS = 15_000

/** Per-request options. `signal` is React Query's queryFn signal (so unmount /
 *  re-query cancels the in-flight fetch); it is combined with a hard timeout. */
export type RequestOpts = { signal?: AbortSignal; timeoutMs?: number }

// Combine a default timeout with any caller signal; either source aborts fetch.
// `timeout` is returned so callers can tell a timeout from a caller-cancel.
export function withTimeout(opts?: RequestOpts): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  return { signal, timeout }
}
