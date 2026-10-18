// A local stand-in for the iptv service (crates/iptv): records every request
// Hono forwards and answers with a per-test handler. Points env.iptvServiceUrl
// at itself, and turns IPTV on (the CI no-iptv job sets IPTV_DISABLED), until
// close().

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { env } from '../env.js'

export type StubCall = { method: string; url: string; headers: IncomingHttpHeaders; body: string }
export type StubHandler = (call: StubCall, res: ServerResponse) => void

const okJson: StubHandler = (_call, res) => {
  res.setHeader('content-type', 'application/json')
  res.end('{"ok":true}')
}

export async function startIptvStub() {
  const calls: StubCall[] = []
  let handler = okJson
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const call = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() }
      calls.push(call)
      handler(call, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const envRw = env as { iptvServiceUrl: string; IPTV_DISABLED: boolean }
  const prev = { url: envRw.iptvServiceUrl, disabled: envRw.IPTV_DISABLED }
  envRw.iptvServiceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  envRw.IPTV_DISABLED = false
  return {
    calls,
    respond(next: StubHandler) {
      handler = next
    },
    reset() {
      calls.length = 0
      handler = okJson
    },
    async close() {
      envRw.iptvServiceUrl = prev.url
      envRw.IPTV_DISABLED = prev.disabled
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
