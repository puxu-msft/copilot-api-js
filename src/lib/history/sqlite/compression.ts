/**
 * JSON + compression helpers for history blob storage.
 *
 * Storage codec: writes are **zstd** (level 3 — empirically the best
 * size/speed tradeoff for our request payloads, ~2× smaller than gzip at
 * comparable speed). Reads auto-detect the format from the leading magic
 * bytes, so pre-existing **gzip** blobs remain transparently readable with no
 * migration:
 *
 *   - `1f 8b …`        → gzip (legacy rows written before this change)
 *   - `28 b5 2f fd …`  → zstd (current writes)
 *
 * Both codecs are provided by `node:zlib`, which works on Bun and Node alike
 * (Node ≥22.15 for zstd — consistent with the project's "Node is a compat
 * target" posture; bun:sqlite/node:sqlite already require Node ≥22.5).
 */

import {
  //
  constants as zlibConstants,
  gunzipSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib"

/** zstd compression level used for all writes. L3 ≈ 79% reduction at ~7ms on a 1.2 MB payload. */
export const STORAGE_ZSTD_LEVEL = 3

const ZSTD_OPTS = { params: { [zlibConstants.ZSTD_c_compressionLevel]: STORAGE_ZSTD_LEVEL } } as const

/** Compress a JSON-serializable value into a zstd-framed blob for storage. */
export function compress(value: unknown): Uint8Array {
  const json = JSON.stringify(value)
  return zstdCompressSync(json, ZSTD_OPTS)
}

/**
 * Decompress a storage blob back into its JSON value, auto-detecting gzip
 * (legacy) vs zstd (current) from the magic bytes. Throws on an empty /
 * truncated / unrecognized blob rather than silently returning undefined — a
 * corrupt blob is a real fault the caller must see.
 */
export function decompress(blob: Uint8Array): unknown {
  if (blob.length < 4) {
    throw new Error(`[history/sqlite] decompress: blob too short (${blob.length} bytes) to identify format`)
  }
  const bytes = decompressRaw(blob)
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Magic-byte dispatch to the matching decompressor. Throws on unrecognized magic. */
function decompressRaw(blob: Uint8Array): Uint8Array {
  if (isGzip(blob)) return gunzipSync(blob)
  if (isZstd(blob)) return zstdDecompressSync(blob)
  const magic = Array.from(blob.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ")
  throw new Error(`[history/sqlite] decompress: unrecognized blob magic [${magic}] (expected gzip 1f8b or zstd 28b52ffd)`)
}

/** gzip magic: 0x1f 0x8b. */
function isGzip(b: Uint8Array): boolean {
  return b[0] === 0x1f && b[1] === 0x8b
}

/** zstd frame magic: 0x28 0xb5 0x2f 0xfd. */
function isZstd(b: Uint8Array): boolean {
  return b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd
}

/** Compress with the legacy gzip codec. Retained ONLY for backward-compat tests. */
export function gzipJsonLegacy(value: unknown): Uint8Array {
  return gzipSync(JSON.stringify(value))
}
