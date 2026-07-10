import { describe, expect, it } from 'vitest'
import {
  app,
  PASSKEY_BODY_LIMIT_BYTES,
  SIDECAR_CONTROL_BODY_LIMIT_BYTES,
} from './app.js'
import { env } from './env.js'

function requestHeaders(): Record<string, string> {
  const origin = env.allowedOrigins[0]
  return {
    'Content-Type': 'application/json',
    ...(origin ? { Origin: origin } : {}),
  }
}

describe('app edge security policy', () => {
  it('prevents every backend-served response from being framed', async () => {
    const response = await app.request('/api/health')
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('rejects an oversized public passkey body before ceremony parsing', async () => {
    const response = await app.request('/api/auth/passkey/register/options', {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({ handle: 'Owner', padding: 'x'.repeat(PASSKEY_BODY_LIMIT_BYTES) }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
  })

  it('bounds chunked sidecar control bodies before auth or proxy buffering', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > SIDECAR_CONTROL_BODY_LIMIT_BYTES) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
        sent += chunk.byteLength
      },
    })
    const request = new Request('http://localhost/api/media/watch', {
      method: 'POST',
      headers: requestHeaders(),
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const response = await app.request(request)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
  })
})
