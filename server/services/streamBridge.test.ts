import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import {
  nodeReadableToWebStream,
  webStreamToNodeReadable,
  gunzipNodeStream,
} from './streamBridge.js'

// Drain a Web ReadableStream<Uint8Array> into a single Buffer.
async function readWeb(web: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = web.getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

// Drain a Node Readable into a single Buffer.
async function readNode(node: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of node) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

describe('streamBridge.nodeReadableToWebStream', () => {
  it('converts a Node Readable into a Web ReadableStream preserving bytes', async () => {
    const node = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const web = nodeReadableToWebStream(node)
    expect(typeof web.getReader).toBe('function')
    const out = await readWeb(web)
    expect(out.toString()).toBe('hello world')
  })
})

describe('streamBridge.webStreamToNodeReadable', () => {
  it('converts a Web ReadableStream into a Node Readable preserving bytes', async () => {
    const payload = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6])]
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload[0])
        controller.enqueue(payload[1])
        controller.close()
      },
    })
    const node = webStreamToNodeReadable(web)
    expect(node).toBeInstanceOf(Readable)
    const out = await readNode(node)
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('streamBridge.gunzipNodeStream', () => {
  it('decompresses a gzipped Node stream back to the original bytes', async () => {
    const original = '<tv><channel/></tv>'
    const gzipped = gzipSync(Buffer.from(original))
    const node = Readable.from([gzipped])
    const out = await readNode(gunzipNodeStream(node))
    expect(out.toString()).toBe(original)
  })
})

describe('streamBridge round-trip', () => {
  it('node -> web -> node returns identical multi-chunk bytes', async () => {
    const chunks = [
      Buffer.from('the quick '),
      Buffer.from('brown fox '),
      Buffer.from('jumps'),
    ]
    const expected = Buffer.concat(chunks)
    const web = nodeReadableToWebStream(Readable.from(chunks))
    const back = webStreamToNodeReadable(web as ReadableStream<Uint8Array>)
    const out = await readNode(back)
    expect(out.equals(expected)).toBe(true)
  })
})
