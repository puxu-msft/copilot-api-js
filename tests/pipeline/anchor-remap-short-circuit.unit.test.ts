import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  LegToken,
  WireBlockMapping,
} from "~/lib/pipeline/delivery/types"
import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  remapAnthropicBlockIndex,
  resolveRemappedFrame,
} from "~/lib/anthropic/keepalive-anchor"

const leg = "leg-test" as LegToken
const realStartFrame = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const mapping = (upstreamIndex: number, wireIndex: number): WireBlockMapping => ({
  upstreamIndex,
  wireIndex,
  leg,
  remap: (frame) => remapAnthropicBlockIndex(frame, wireIndex - upstreamIndex),
})

test("no-anchor PRIMARY leg: structurally bypassed — the SAME frame object is returned", () => {
  const frame = realStartFrame(0)
  expect(resolveRemappedFrame(frame, mapping(0, 0))).toBe(frame)
})

test("no-anchor CONTINUATION leg: MUST remap even though no anchor was opened", () => {
  const frame = realStartFrame(0)
  const out = resolveRemappedFrame(frame, mapping(0, 1))
  expect(out).not.toBe(frame)
  expect(JSON.parse(out.data as string).index).toBe(1)
})

test("RECOVERY leg with no prior anchor: upstream 0 to wire 0 stays identity", () => {
  const frame = realStartFrame(0)
  expect(resolveRemappedFrame(frame, mapping(0, 0))).toBe(frame)
})

test("RECOVERY leg after a pre-content anchor: upstream 0 to wire 1 MUST remap", () => {
  const frame = realStartFrame(0)
  const out = resolveRemappedFrame(frame, mapping(0, 1))
  expect(out).not.toBe(frame)
  expect(JSON.parse(out.data as string).index).toBe(1)
})

test("anchor opened on the primary leg: a non-identity mapping remaps", () => {
  const frame = realStartFrame(1)
  const out = resolveRemappedFrame(frame, mapping(1, 2))
  expect(out).not.toBe(frame)
  expect(JSON.parse(out.data as string).index).toBe(2)
})
