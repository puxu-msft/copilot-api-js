import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { encodeSseFrame } from "~/lib/pipeline/sse-encoder"

describe("lossless SSE encoder", () => {
  test("returns immutable bytes and projection from one wire-only frame", () => {
    const encoded = encodeSseFrame({ event: "message", data: "a\nb", id: 7, retry: 0 })
    expect(new TextDecoder().decode(encoded.bytes)).toBe("event: message\ndata: a\ndata: b\nid: 7\nretry: 0\n\n")
    expect(encoded.projection).toEqual({ event: "message", data: "a\nb", id: "7", retry: 0 })
    expect(Object.isFrozen(encoded)).toBe(true)
    expect(Object.isFrozen(encoded.projection)).toBe(true)
  })

  test("preserves an explicit empty ID as a bare id line", () => {
    const encoded = encodeSseFrame({ data: "reset", id: "" })
    expect(new TextDecoder().decode(encoded.bytes)).toBe("data: reset\nid:\n\n")
    expect(encoded.projection).toEqual({ data: "reset", id: "" })
  })

  test("omits absent fields and still encodes empty data", () => {
    const encoded = encodeSseFrame({})
    expect(new TextDecoder().decode(encoded.bytes)).toBe("data:\n\n")
    expect(encoded.projection).toEqual({ data: "" })
  })

  test("normalizes event and ID newlines to one client-visible field", async () => {
    const { decodeSseWrite } = await import("../helpers/sse-write-stream")
    const encoded = encodeSseFrame({ event: "a\rb", data: "x\r\ny\rz", id: "i\nj", retry: 0 })
    expect(new TextDecoder().decode(encoded.bytes)).toBe("event: a b\ndata: x\ndata: y\ndata: z\nid: i j\nretry: 0\n\n")
    expect(decodeSseWrite(encoded.bytes)).toEqual(encoded.projection)
  })

  test("fails closed for an ID containing U+0000 instead of projecting a client-ignored field", async () => {
    const { decodeSseWrite } = await import("../helpers/sse-write-stream")
    expect(decodeSseWrite("data: payload\nid: bad\0id\n\n")).toEqual({ data: "payload" })
    expect(() => encodeSseFrame({ data: "payload", id: "bad\0id" })).toThrow(/id/i)
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed for invalid retry %p",
    (retry) => {
      expect(() => encodeSseFrame({ data: "payload", retry })).toThrow(/retry/i)
    },
  )

  test.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts safe non-negative retry %p", async (retry) => {
    const { decodeSseWrite } = await import("../helpers/sse-write-stream")
    const encoded = encodeSseFrame({ data: "payload", retry })
    expect(decodeSseWrite(encoded.bytes)).toEqual(encoded.projection)
  })

  test("does not attach origin metadata to an untagged wire-only frame", () => {
    const encoded = encodeSseFrame({ data: "payload", event: "event\nreplacement" })
    expect(encoded.projection).toEqual({ event: "event replacement", data: "payload" })
  })
})
