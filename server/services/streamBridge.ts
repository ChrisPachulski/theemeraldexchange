// Typed bridge for the few places we cross Node <-> Web stream boundaries.
//
// Node's `Readable.toWeb` / `Readable.fromWeb` are typed against Node's own
// `ReadableStream` global (from `types: ["node"]`), which is structurally
// distinct from the DOM/Fetch `ReadableStream` the `Response` constructor and
// `res.body` use. The `as unknown` hops below are pure type bridges — they
// reconcile two compatible-at-runtime shapes the compiler refuses to unify.
// Centralising them here keeps every call site cast-free and the unsafe hops
// named, audited, and unit-tested. No runtime behaviour lives here.

import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

// `toWeb` returns Node's `ReadableStream`; the Fetch `Response` constructor
// expects the global/DOM `ReadableStream`. Behaviour-neutral type bridge.
export function nodeReadableToWebStream(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream
}

// `fromWeb` is typed against Node's `ReadableStream`; a Fetch `res.body` is the
// DOM `ReadableStream<Uint8Array>`. Behaviour-neutral type bridge.
export function webStreamToNodeReadable(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as ReadableStream<Uint8Array>)
}

// `pipe` is typed to return the generic `Writable` shape of the gunzip
// transform; consumers need it as a `Readable`. Behaviour-neutral type bridge.
export function gunzipNodeStream(stream: Readable): Readable {
  return stream.pipe(createGunzip()) as unknown as Readable
}
