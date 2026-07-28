import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  assertBlockProtocolState,
  assertMonotonicWireIndices,
  wireShape,
} from "./wire-index-oracle"

function frame(type: string, index?: number): ClientFrame {
  return {
    event: type,
    data: JSON.stringify({ type, ...(index === undefined ? {} : { index }) }),
  }
}

const startFrame = (index: number): ClientFrame => frame("content_block_start", index)
const deltaFrame = (index: number): ClientFrame => frame("content_block_delta", index)
const stopFrame = (index: number): ClientFrame => frame("content_block_stop", index)

describe("wire-index and block-protocol-state producer oracles", () => {
  test("assertMonotonicWireIndices rejects a duplicated index", () => {
    expect(() => assertMonotonicWireIndices([startFrame(0), stopFrame(0), startFrame(0)])).toThrow()
  })

  test("assertMonotonicWireIndices rejects a gap in the sequence", () => {
    expect(() => assertMonotonicWireIndices([startFrame(0), stopFrame(0), startFrame(2)])).toThrow()
  })

  test("assertBlockProtocolState rejects two blocks open at once", () => {
    expect(() => assertBlockProtocolState([startFrame(0), startFrame(1)])).toThrow()
  })

  test("assertBlockProtocolState rejects an orphan delta", () => {
    expect(() => assertBlockProtocolState([startFrame(1), deltaFrame(0)])).toThrow()
  })

  test("assertBlockProtocolState rejects a stop with the wrong index", () => {
    expect(() => assertBlockProtocolState([startFrame(1), stopFrame(0)])).toThrow()
  })

  test("assertBlockProtocolState rejects a dangling open block", () => {
    expect(() => assertBlockProtocolState([startFrame(0)])).toThrow()
  })

  test("assertBlockProtocolState rejects a duplicated stop", () => {
    expect(() => assertBlockProtocolState([startFrame(0), stopFrame(0), stopFrame(0)])).toThrow()
  })

  test("both accept the current sequential shape", () => {
    const sequential = [startFrame(0), deltaFrame(0), stopFrame(0), startFrame(1), deltaFrame(1), stopFrame(1)]

    expect(() => assertMonotonicWireIndices(sequential)).not.toThrow()
    expect(() => assertBlockProtocolState(sequential)).not.toThrow()
    expect(wireShape(sequential)).toEqual(["real_start@0", "delta@0", "real_stop@0", "real_start@1", "delta@1", "real_stop@1"])
  })

  test("wireShape uses the caller-owned forwarded provenance to label anchor structure", () => {
    const anchorStart = startFrame(0)
    const anchorStop = stopFrame(0)
    const sequential = [anchorStart, deltaFrame(0), anchorStop, startFrame(1), stopFrame(1)]
    const anchors = new Set([anchorStart, anchorStop])

    expect(wireShape(sequential, { isAnchorFrame: (current) => anchors.has(current) })).toEqual([
      "anchor_start@0",
      "delta@0",
      "anchor_stop@0",
      "real_start@1",
      "real_stop@1",
    ])
  })
})
