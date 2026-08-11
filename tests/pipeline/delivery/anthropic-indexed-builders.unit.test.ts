/**
 * The one piece of logic in the Anthropic indexed builders: whether a frame needs re-addressing.
 *
 * The anchor builders are pass-throughs to `keepalive-anchor.ts`, so asserting their bytes here
 * would only restate that file's own goldens. What is worth pinning is the identity rule, because
 * getting it wrong is silent: a re-serialized "equal" frame breaks `===` for callers that compare
 * frames, and a missed shift puts a block at the wrong client index.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createAnthropicIndexedBuilders } from "~/lib/pipeline/delivery/anthropic-indexed-builders"

const builders = createAnthropicIndexedBuilders()

function blockFrame(index: number): { data: string } {
  return { data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: "hi" } }) }
}

describe("anthropic indexed builders", () => {
  test("an identity mapping returns the ORIGINAL object, not an equal copy", () => {
    const frame = blockFrame(2)
    expect(builders.remapToWireIndex(frame, 2, 2)).toBe(frame)
  })

  test("a shifted mapping re-addresses the block to the wire index", () => {
    const remapped = builders.remapToWireIndex(blockFrame(0), 1, 0) as { data: string }
    expect(JSON.parse(remapped.data)).toMatchObject({ type: "content_block_delta", index: 1 })
  })

  test("the shift is wireIndex - upstreamIndex, not a count of anchors", () => {
    // A continuation or recovery leg restarts upstream indices, so a block that is upstream 0 can
    // land at wire 5 with no anchor involved. Deriving the offset from an anchor count would put
    // this frame at index 1.
    const remapped = builders.remapToWireIndex(blockFrame(0), 5, 0) as { data: string }
    expect(JSON.parse(remapped.data)).toMatchObject({ index: 5 })
  })

  test("the anchor builders address the wire index they are given", () => {
    const start = builders.buildAnchorStart(3) as { data: string }
    const delta = builders.buildAnchorDelta(3) as { data: string }
    const stop = builders.buildAnchorStop(3) as { data: string }

    expect(JSON.parse(start.data)).toMatchObject({ type: "content_block_start", index: 3 })
    expect(JSON.parse(delta.data)).toMatchObject({ type: "content_block_delta", index: 3 })
    expect(JSON.parse(stop.data)).toMatchObject({ type: "content_block_stop", index: 3 })
  })
})
