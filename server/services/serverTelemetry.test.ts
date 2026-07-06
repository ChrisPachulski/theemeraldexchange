// Integration tests for the §15-mandatory server-side Glitchtip relay
// (server/services/serverTelemetry.ts). `reportServerEvent` is voided
// (fire-and-forget) by suggestions/recommender/iptvScheduler/dbBackupScheduler;
// this file is its only coverage.
//
// Mechanics worth knowing before editing:
//   - env.EEX_TELEMETRY_DSN is read ONCE at module load (server/env.ts builds a
//     frozen `env` object — no re-reading of process.env at call time). So we
//     CANNOT mutate process.env per test. Each DSN scenario re-mocks ../env.js
//     and re-imports the module under test via vi.resetModules() + a dynamic
//     import (the `loadWithDsn` helper below).
//   - ./upstream.js (fetchWithTimeout) is mocked so we can assert the exact
//     URL / headers / body / timeout / label without real network I/O.
//   - ./telemetryPiiScrub.js is intentionally NOT mocked. The §15.3 PII
//     redaction guarantee is load-bearing, so we run the REAL scrubber and
//     prove end-to-end that secrets are stripped from the relayed payload.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared spy. Every loadWithDsn() wires this same fn into the upstream mock so
// assertions read off one place regardless of which module instance imported it.
const fetchWithTimeout = vi.fn(async () => new Response(null, { status: 200 }))

type RelayInit = {
  method: string
  headers: Record<string, string>
  body: string
}

type ServerTelemetryModule = typeof import('./serverTelemetry.js')

// Re-import serverTelemetry.ts with a specific DSN baked into the env mock.
// resetModules() drops the cached frozen env + module instance so the new DSN
// is the one read at load.
async function loadWithDsn(dsn: string | undefined): Promise<ServerTelemetryModule> {
  vi.resetModules()
  vi.doMock('../env.js', () => ({ env: { EEX_TELEMETRY_DSN: dsn } }))
  vi.doMock('./upstream.js', () => ({ fetchWithTimeout }))
  return import('./serverTelemetry.js')
}

// Pull the parsed body + parsed-out fields from the (single) relay call.
function lastRelay(): { url: string; init: RelayInit; body: Record<string, unknown> } {
  const call = fetchWithTimeout.mock.calls.at(-1) as unknown as [string, RelayInit, number, string]
  const [url, init] = call
  return { url, init, body: JSON.parse(init.body) as Record<string, unknown> }
}

describe('reportServerEvent (Glitchtip relay)', () => {
  beforeEach(() => {
    fetchWithTimeout.mockClear()
    fetchWithTimeout.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('is a no-op when no DSN is provisioned (undefined)', async () => {
    const { reportServerEvent } = await loadWithDsn(undefined)
    await reportServerEvent({ message: 'boom' })
    expect(fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('relays to the Glitchtip store endpoint with correct URL, headers, timeout, and label', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    await reportServerEvent({ message: 'recommender sidecar down' })

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1)
    const call = fetchWithTimeout.mock.calls[0] as unknown as [string, RelayInit, number, string]
    const [url, init, timeout, label] = call

    expect(url).toBe('https://glitchtip.test/api/42/store/')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['X-Sentry-Auth']).toBe(
      'Sentry sentry_version=7, sentry_key=abc123',
    )
    expect(timeout).toBe(2000)
    expect(label).toBe('telemetry.relay')

    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body.platform).toBe('node')
    expect(body.level).toBe('error') // default when event.level omitted
    expect(body.message).toBe('recommender sidecar down')
  })

  it('honors an explicit warning level', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    await reportServerEvent({ level: 'warning', message: 'x' })
    expect(lastRelay().body.level).toBe('warning')
  })

  it('honors an explicit info level', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    await reportServerEvent({ level: 'info', message: 'x' })
    expect(lastRelay().body.level).toBe('info')
  })

  it('is a no-op for a malformed DSN (new URL throws)', async () => {
    const { reportServerEvent } = await loadWithDsn('not a url')
    await reportServerEvent({ message: 'boom' })
    expect(fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('is a no-op when the DSN has no projectId (empty pathname)', async () => {
    const { reportServerEvent } = await loadWithDsn('https://key@host/')
    await reportServerEvent({ message: 'boom' })
    expect(fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('is a no-op when the DSN has no key (no key@ userinfo)', async () => {
    const { reportServerEvent } = await loadWithDsn('https://host/42')
    await reportServerEvent({ message: 'boom' })
    expect(fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('scrubs a JWE-shaped token out of the message before relaying (§15.3)', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    await reportServerEvent({ message: 'stream grant eyJhbGciOiJIUzI1.payloadpart' })

    const { init, body } = lastRelay()
    // The raw secret tail must be absent from the serialized body...
    expect(init.body).not.toContain('payloadpart')
    expect(init.body).not.toContain('eyJhbGciOiJIUzI1')
    // ...and the message must carry the redacted form instead.
    expect(body.message).toBe('stream grant REDACTED.')
  })

  it('redacts secret-keyed context values while preserving non-secret keys (§15.3)', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    await reportServerEvent({
      message: 'x',
      context: { token: 'super-secret-value', note: 'keep' },
    })

    const { init, body } = lastRelay()
    const extra = body.extra as Record<string, unknown>
    expect(extra.token).toBe('REDACTED')
    expect(extra.note).toBe('keep')
    // The raw secret must never reach the wire.
    expect(init.body).not.toContain('super-secret-value')
  })

  it('emits an empty extra object when no context is supplied', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    await reportServerEvent({ message: 'x' })
    expect(lastRelay().body.extra).toEqual({})
  })

  it('swallows relay failures so telemetry never breaks the caller', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    fetchWithTimeout.mockRejectedValueOnce(new Error('glitchtip down'))
    await expect(reportServerEvent({ message: 'boom' })).resolves.toBeUndefined()
  })

  // §S0-1: fetchWithTimeout NEVER throws — a DNS/connect failure returns a
  // synthesized 504 and a Glitchtip rejection a real 4xx/5xx. The old relay
  // ignored the Response entirely, so a background-job error that was NEVER
  // delivered vanished without a trace. It must now be visible.
  it('makes a dropped background event VISIBLE: warns on a non-2xx relay response', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    fetchWithTimeout.mockResolvedValueOnce(new Response(null, { status: 504 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await reportServerEvent({ message: 'db backup failed' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[telemetry]')
    warn.mockRestore()
  })

  it('never leaks the event payload into the failure log (host + status only)', async () => {
    const { reportServerEvent } = await loadWithDsn('https://abc123@glitchtip.test/42')
    fetchWithTimeout.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await reportServerEvent({ message: 'grant eyJhbGciOiJIUzI1.secrettail' })
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(line).not.toContain('secrettail')
    expect(line).toContain('glitchtip.test')
    warn.mockRestore()
  })
})

// A shared spy for the DNS resolver used by the boot self-check. Every case
// injects a deterministic resolver so no real DNS I/O happens (mirrors
// ssrfGuard.__setSsrfLookupForTests).
describe('runTelemetryDsnSelfCheck (boot DSN self-check, §S0-1)', () => {
  beforeEach(() => {
    fetchWithTimeout.mockClear()
    fetchWithTimeout.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('returns disabled and stays quiet when no DSN is provisioned', async () => {
    const { runTelemetryDsnSelfCheck } = await loadWithDsn(undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runTelemetryDsnSelfCheck(async () => [{ address: '10.0.0.1' }])
    expect(res).toEqual({ status: 'disabled' })
    expect(err).not.toHaveBeenCalled()
    expect(fetchWithTimeout).not.toHaveBeenCalled()
    err.mockRestore()
  })

  // THE actual §S0-1 production outage: the DSN host is unresolvable from
  // inside the docker network. This must be LOUD (error level), not swallowed.
  it('LOUDLY logs + returns unresolvable when the DSN host does not resolve (ENOTFOUND)', async () => {
    const { runTelemetryDsnSelfCheck } = await loadWithDsn(
      'https://k@glitchtip.tailnet.ts.net/7',
    )
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const enotfound = Object.assign(
      new Error('getaddrinfo ENOTFOUND glitchtip.tailnet.ts.net'),
      { code: 'ENOTFOUND' },
    )
    const res = await runTelemetryDsnSelfCheck(async () => {
      throw enotfound
    })
    expect(res.status).toBe('unresolvable')
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toContain('UNRESOLVABLE')
    // DNS already failed — never wastes a probe on an unresolvable host.
    expect(fetchWithTimeout).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('probes the store endpoint and passes when DNS resolves and the endpoint accepts', async () => {
    const { runTelemetryDsnSelfCheck } = await loadWithDsn('https://k@glitchtip.test/7')
    fetchWithTimeout.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const res = await runTelemetryDsnSelfCheck(async () => [{ address: '10.0.0.9' }])
    expect(res).toEqual({ status: 'ok', hostname: 'glitchtip.test' })
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1)
    const call = fetchWithTimeout.mock.calls[0] as unknown as [string, RelayInit, number, string]
    expect(call[0]).toBe('https://glitchtip.test/api/7/store/')
    expect(call[3]).toBe('telemetry.selfcheck')
  })

  it('LOUDLY logs + returns probe_failed when DNS resolves but the endpoint rejects', async () => {
    const { runTelemetryDsnSelfCheck } = await loadWithDsn('https://k@glitchtip.test/7')
    fetchWithTimeout.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runTelemetryDsnSelfCheck(async () => [{ address: '10.0.0.9' }])
    expect(res).toEqual({ status: 'probe_failed', hostname: 'glitchtip.test', detail: 'http_401' })
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })

  it('returns probe_failed when the probe itself throws', async () => {
    const { runTelemetryDsnSelfCheck } = await loadWithDsn('https://k@glitchtip.test/7')
    fetchWithTimeout.mockRejectedValueOnce(new Error('socket hang up'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runTelemetryDsnSelfCheck(async () => [{ address: '10.0.0.9' }])
    expect(res.status).toBe('probe_failed')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('LOUDLY logs + returns misconfigured for a malformed DSN', async () => {
    const { runTelemetryDsnSelfCheck } = await loadWithDsn('not a url')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runTelemetryDsnSelfCheck(async () => [{ address: '10.0.0.9' }])
    expect(res).toEqual({ status: 'misconfigured' })
    expect(err).toHaveBeenCalledTimes(1)
    expect(fetchWithTimeout).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
