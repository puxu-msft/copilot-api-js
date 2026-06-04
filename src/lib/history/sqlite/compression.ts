/** JSON + gzip helpers for history blob storage. */

import {
  //
  gunzipSync,
  gzipSync,
} from "node:zlib"

export function gzipJson(value: unknown): Uint8Array {
  const json = JSON.stringify(value)
  // node:zlib is available on both Node and Bun and returns a Buffer (a
  // Uint8Array subclass). Earlier code used Bun.gzipSync, which crashes on
  // Node with `ReferenceError: Bun is not defined` and silently drops history
  // writes.
  return gzipSync(json)
}

export function gunzipJson(blob: Uint8Array): unknown {
  const bytes = gunzipSync(blob)
  const text = new TextDecoder().decode(bytes)
  return JSON.parse(text)
}
