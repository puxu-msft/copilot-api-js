/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — pure frame codec unit tests (no socket involved -- `.unit.test.ts`).
 * The socket-level fragmentation/coalescing behaviour is exercised end-to-end in
 * `uds-transport.it.test.ts` (real UDS bytes dribbled in small pieces); this file
 * proves the DECODER's reducer logic in isolation against hand-constructed
 * fragment boundaries, independent of any actual socket timing.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  encodeFrame,
  FrameDecoder,
  isWireError,
} from "~/lib/history/search/protocol"

describe("encodeFrame / FrameDecoder round-trip", () => {
  test("encodes then decodes a single value in one push", () => {
    const frame = encodeFrame({ query: "needle", limit: 10 })
    const decoder = new FrameDecoder()
    expect(decoder.push(frame)).toEqual([{ query: "needle", limit: 10 }])
  })

  test("decodes multiple frames coalesced into a single chunk", () => {
    const frame1 = encodeFrame({ a: 1 })
    const frame2 = encodeFrame({ b: 2 })
    const decoder = new FrameDecoder()
    expect(decoder.push(Buffer.concat([frame1, frame2]))).toEqual([{ a: 1 }, { b: 2 }])
  })

  test("a frame split across many small pushes decodes only once the LAST piece arrives", () => {
    const frame = encodeFrame({ query: "split across pieces", limit: 5 })
    const decoder = new FrameDecoder()
    const pieces: Array<Buffer> = []
    for (let i = 0; i < frame.length; i += 3) pieces.push(frame.subarray(i, i + 3))
    expect(pieces.length).toBeGreaterThan(1) // sanity: the frame really did get split

    let decoded: Array<unknown> = []
    for (const piece of pieces) {
      const fromThisPiece = decoder.push(piece)
      // every push before the last must decode NOTHING (frame incomplete)
      if (piece !== pieces.at(-1)) expect(fromThisPiece).toEqual([])
      decoded = decoded.length > 0 ? decoded : fromThisPiece
    }
    expect(decoded).toEqual([{ query: "split across pieces", limit: 5 }])
  })

  test("the length prefix ITSELF can arrive split across two pushes", () => {
    const frame = encodeFrame({ tiny: true })
    const decoder = new FrameDecoder()
    // Split strictly inside the 4-byte length header (byte 2 of 4).
    expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.push(frame.subarray(2))).toEqual([{ tiny: true }])
  })

  test("a second frame's bytes arriving alongside the first frame's tail still decode both, once each", () => {
    const frame1 = encodeFrame({ first: 1 })
    const frame2 = encodeFrame({ second: 2 })
    const decoder = new FrameDecoder()
    const combined = Buffer.concat([frame1, frame2])
    // Deliver byte-by-byte to stress worst-case fragmentation across the boundary.
    let decoded: Array<unknown> = []
    for (let i = 0; i < combined.length; i++) decoded = decoded.concat(decoder.push(combined.subarray(i, i + 1)))
    expect(decoded).toEqual([{ first: 1 }, { second: 2 }])
  })

  test("a very large payload (bigger than any single realistic TCP segment) round-trips intact", () => {
    const bigQuery = "x".repeat(200_000)
    const frame = encodeFrame({ query: bigQuery, limit: 30 })
    const decoder = new FrameDecoder()
    // Deliver in small (1500-byte, MTU-ish) pieces to mirror real fragmentation.
    let decoded: Array<unknown> = []
    for (let i = 0; i < frame.length; i += 1500) decoded = decoded.concat(decoder.push(frame.subarray(i, i + 1500)))
    expect(decoded).toEqual([{ query: bigQuery, limit: 30 }])
  })

  test("throws when the declared frame length exceeds the safety cap (hostile/corrupt length prefix)", () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(64 * 1024 * 1024, 0) // 64 MiB — over the 16 MiB cap
    const decoder = new FrameDecoder()
    expect(() => decoder.push(header)).toThrow(/exceeds.*byte cap/)
  })

  test("throws building a frame whose body exceeds the safety cap", () => {
    const huge = "x".repeat(20 * 1024 * 1024)
    expect(() => encodeFrame({ query: huge, limit: 1 })).toThrow(/exceeds.*byte cap/)
  })
})

describe("isWireError", () => {
  test("recognizes an error reply", () => {
    expect(isWireError({ error: "boom" })).toBe(true)
  })

  test("rejects a normal rows reply", () => {
    expect(isWireError({ rows: [] })).toBe(false)
  })

  test("rejects non-objects", () => {
    expect(isWireError(null)).toBe(false)
    expect(isWireError("boom")).toBe(false)
    expect(isWireError(42)).toBe(false)
  })
})
