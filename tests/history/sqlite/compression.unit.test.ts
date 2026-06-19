import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  compress,
  decompress,
  gzipJsonLegacy,
} from "~/lib/history/sqlite/compression"

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
})
