// Size-bounded JSON body reader for small POST bodies.
//
// c.req.json() buffers the entire body before parsing, so a hostile client
// could stream an arbitrarily large payload into memory. This reader rejects
// via Content-Length up front when the client declares one, and otherwise
// counts streamed bytes and cancels the moment the cap is crossed.
//
// Fallback shape: `body` is `null` whenever there is no parseable JSON body
// (absent body, stream error, malformed JSON). Callers that prefer an empty
// object normalize with `parsed.body ?? {}` — null is kept as the canonical
// "nothing usable arrived" signal so callers can distinguish it when needed.

import type { Context } from 'hono'

export type LimitedJsonResult = { tooLarge: boolean; body: unknown | null }

export async function parseLimitedJson(
  c: Context,
  maxBytes: number,
): Promise<LimitedJsonResult> {
  const contentLength = c.req.header('content-length')
  if (contentLength) {
    const n = Number(contentLength)
    if (Number.isFinite(n) && n > maxBytes) return { tooLarge: true, body: null }
  }
  const stream = c.req.raw.body
  if (!stream) return { tooLarge: false, body: null }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { tooLarge: true, body: null }
      }
      chunks.push(value)
    }
  } catch {
    return { tooLarge: false, body: null }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { tooLarge: false, body: null }
  }
}
