import { describe, expect, test } from "bun:test"

import { gunzipJson, gzipJson } from "~/lib/history/sqlite/compression"

describe("sqlite/compression", () => {
  test("roundtrips arbitrary JSON", () => {
    const obj = {
      messages: [{ role: "user", content: "hello 压缩" }],
      meta: { a: 1, b: null, c: [true, false] },
    }
    const blob = gzipJson(obj)
    expect(blob).toBeInstanceOf(Uint8Array)
    expect(blob.length).toBeGreaterThan(0)
    expect(gunzipJson(blob)).toEqual(obj)
  })

  test("gzipJson produces smaller output for repetitive payloads", () => {
    const big = { text: "abc".repeat(2000) }
    const blob = gzipJson(big)
    expect(blob.length).toBeLessThan(JSON.stringify(big).length / 4)
  })

  test("gunzipJson throws on malformed blob", () => {
    expect(() => gunzipJson(new Uint8Array([0, 1, 2, 3, 4]))).toThrow()
  })
})
