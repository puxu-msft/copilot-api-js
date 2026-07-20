import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  compress,
  compressAsync,
  compressBytes,
  decompress,
  decompressBytes,
  gzipJsonLegacy,
} from "~/lib/sqlite/compression"

describe("sqlite/compression", () => {
  test("roundtrips arbitrary JSON through zstd", () => {
    const obj = {
      messages: [{ role: "user", content: "hello 压缩" }],
      meta: { a: 1, b: null, c: [true, false] },
    }
    const blob = compress(obj)
    expect(blob).toBeInstanceOf(Uint8Array)
    expect(blob.length).toBeGreaterThan(0)
    // zstd frame magic
    expect([blob[0], blob[1], blob[2], blob[3]]).toEqual([0x28, 0xb5, 0x2f, 0xfd])
    expect(decompress(blob)).toEqual(obj)
  })

  test("compress produces smaller output for repetitive payloads", () => {
    const big = { text: "abc".repeat(2000) }
    const blob = compress(big)
    expect(blob.length).toBeLessThan(JSON.stringify(big).length / 4)
  })

  test("decompress transparently reads legacy gzip blobs (backward compat)", () => {
    const obj = { id: "req_legacy", messages: [{ role: "user", content: "历史 gzip blob" }], meta: { v: 1 } }
    const legacyBlob = gzipJsonLegacy(obj)
    // gzip magic
    expect([legacyBlob[0], legacyBlob[1]]).toEqual([0x1f, 0x8b])
    expect(decompress(legacyBlob)).toEqual(obj)
  })

  test("decompress reads a frozen real-world legacy gzip fixture", () => {
    // Captured from a production history.db row (gzip era). Asserts the magic
    // sniffer decodes a genuine legacy blob, not just one we just produced.
    const fixtureB64 =
      "H4sIAAAAAAAAA6tWykxRslIqSi2Mz0lNT0yuVNJRyk0tLk5MTy1WsoquVirKz0lVslIqLU4tUtJRSs7PK0nNK1GyUnra1/a0f5NCelVmgUJSTn6SUm0sSGdJopJVtVKZkpVhbS0A/jwJTlwAAAA="
    const blob = Uint8Array.from(Buffer.from(fixtureB64, "base64"))
    expect(decompress(blob)).toEqual({ id: "req_legacy", messages: [{ role: "user", content: "历史 gzip blob" }], meta: { v: 1 } })
  })

  test("decompress throws on an empty / too-short blob", () => {
    expect(() => decompress(new Uint8Array([]))).toThrow(/too short/)
    expect(() => decompress(new Uint8Array([0x28, 0xb5, 0x2f]))).toThrow(/too short/)
  })

  test("decompress throws on an unrecognized magic", () => {
    expect(() => decompress(new Uint8Array([0, 1, 2, 3, 4]))).toThrow(/unrecognized blob magic/)
  })

  // P1 (RFC history-finalize-async-offload §5): compressAsync is the libuv-offloaded
  // twin of compress. zstd L3 is deterministic, so the output must be byte-equal —
  // the finalize refactor (P2) swaps compress→compressAsync and relies on this for I6.
  test("compressAsync output is byte-equal to compress (deterministic zstd L3)", async () => {
    const payloads = [
      { messages: [{ role: "user", content: "hello 压缩" }], meta: { a: 1, b: null } },
      { big: "x".repeat(50_000), arr: Array.from({ length: 200 }, (_, i) => ({ i, t: `frame ${i}` })) },
      [],
      "scalar string 标量",
    ]
    for (const p of payloads) {
      const sync = compress(p)
      const async = await compressAsync(p)
      expect(Buffer.from(async)).toEqual(Buffer.from(sync))
      expect(decompress(async)).toEqual(p)
    }
  })

  // P3-a (telemetry sketch blob): raw-bytes variants for binary blobs (DDSketch
  // packed frames) that must NOT go through JSON.stringify (would mangle/inflate
  // a Uint8Array into a JSON number array).
  describe("compressBytes / decompressBytes (raw-bytes, non-JSON)", () => {
    test("roundtrips arbitrary binary data byte-for-byte through zstd", () => {
      const bytes = new Uint8Array(4096)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256 // deterministic pseudo-random fill
      const blob = compressBytes(bytes)
      expect(blob).toBeInstanceOf(Uint8Array)
      // zstd frame magic
      expect([blob[0], blob[1], blob[2], blob[3]]).toEqual([0x28, 0xb5, 0x2f, 0xfd])
      const round = decompressBytes(blob)
      expect(Buffer.from(round)).toEqual(Buffer.from(bytes))
    })

    test("roundtrips an empty byte array", () => {
      const blob = compressBytes(new Uint8Array([]))
      expect(Buffer.from(decompressBytes(blob))).toEqual(Buffer.from([]))
    })

    test("decompressBytes throws a clear error on an empty / too-short blob", () => {
      expect(() => decompressBytes(new Uint8Array([]))).toThrow(/too short/)
      expect(() => decompressBytes(new Uint8Array([0x28, 0xb5, 0x2f]))).toThrow(/too short/)
    })

    test("decompressBytes throws on an unrecognized magic (not JSON.parse'd — raw bytes)", () => {
      expect(() => decompressBytes(new Uint8Array([0, 1, 2, 3, 4]))).toThrow(/unrecognized blob magic/)
    })
  })
})
