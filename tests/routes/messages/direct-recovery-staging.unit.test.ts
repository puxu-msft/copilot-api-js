import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
  remapAnthropicBlockIndex,
} from "~/lib/anthropic/keepalive-anchor"
import { stageDirectRecoveryBatch } from "~/routes/messages/precontent-recovery-sink-chain"

const frame = (type: string, payload: Record<string, unknown> = {}): ClientFrame => ({ event: type, data: JSON.stringify({ type, ...payload }) })

const hooks: AnchorHooks = {
  isMessageStart: (entry) => JSON.parse(entry.data ?? "{}").type === "message_start",
  isContentBlockStart: (entry) => JSON.parse(entry.data ?? "{}").type === "content_block_start",
  startFrame: (index) => frame("content_block_start", { index, content_block: { type: "text", text: "" } }),
  stopFrame: (index) => frame("content_block_stop", { index }),
  deltaFrame: (index) => frame("content_block_delta", { index, delta: { type: "text_delta", text: "" } }),
  remap: remapAnthropicBlockIndex,
}

test("staging marks only the synthetic anchor stop when leading candidate pings precede an empty-text recovery", () => {
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  expect(wireState.allocator.allocateAnchor()).toBe(0)
  const state: AnchorState = {
    wireState,
    injected: true,
    messageStartForwarded: true,
    anchorBlockOpen: true,
    anchorClosed: false,
  }
  const result = stageDirectRecoveryBatch(
    [
      frame("ping"),
      frame("ping"),
      frame("message_start", { message: { id: "recovery" } }),
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "recovered" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_delta"),
      frame("message_stop"),
    ],
    state,
    hooks,
    0,
  )

  expect(result.entries.map(({ kind, frame: entry }) => `${kind}:${JSON.parse(entry.data ?? "{}").type}`)).toEqual([
    "real:ping",
    "real:ping",
    "anchor:content_block_stop",
    "real:content_block_start",
    "real:content_block_delta",
    "real:content_block_stop",
    "real:message_delta",
    "real:message_stop",
  ])
  expect(JSON.parse(result.entries[3]?.frame.data ?? "{}").index).toBe(1)
  const specs = result.specs({
    anchor: (entry) => ({ kind: "anchor", frame: entry }),
    real: (entry) => ({ kind: "real", frame: entry }),
  })
  expect(specs.map((entry) => entry.kind)).toEqual(["real", "real", "anchor", "real", "real", "real", "real", "real"])
  expect(result.state.anchorClosed).toBeTrue()
  expect(state.anchorClosed).toBeFalse()
})
