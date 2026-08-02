import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  AnchorHooks,
  AnchorState,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  createGenerationWireIndexAllocator,
  createGenerationWireState,
  makeSyntheticAnchorInjector,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

const hooks: AnchorHooks = {
  isMessageStart: () => false,
  isContentBlockStart: () => false,
  startFrame: anchorStartFrame,
  stopFrame: anchorStopFrame,
  deltaFrame: anchorDeltaFrame,
  syntheticMessageStart: syntheticMessageStartFrame,
  remap: (frame) => frame,
}

test("the pre-content anchor advances the shared allocator from wire index 0", async () => {
  const allocator = createGenerationWireIndexAllocator()
  const wireState = createGenerationWireState(allocator)
  const state: AnchorState = {
    wireState,
    injected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
  const frames: Array<{ kind: string; data: string }> = []
  const sink: ClientSink = {
    write: async (frame) => {
      frames.push({ kind: "real", data: frame.data ?? "" })
    },
    writeSyntheticEnvelope: async (frame) => {
      frames.push({ kind: "envelope", data: frame.data ?? "" })
    },
    writeAnchor: async (frame) => {
      frames.push({ kind: "anchor", data: frame.data ?? "" })
    },
    writeKeepalive: async (frame) => {
      frames.push({ kind: "keepalive", data: frame.data ?? "" })
    },
  }
  const deliverySink = createDownstreamDeliverySession({ sink, wireState }).clientSink
  const inject = makeSyntheticAnchorInjector({
    anchor: hooks,
    state,
    getSink: () => deliverySink,
    resolvedName: "claude-test",
    reqId: "bridge",
  })

  expect(await inject()).toBe(true)
  expect(state.wireState.allocator).toBe(allocator)
  expect(allocator.anchorsOpened()).toBe(1)
  expect(allocator.nextAnchorIndex()).toBe(1)
  expect(frames.slice(1).map(({ kind, data }) => ({ kind, index: JSON.parse(data).index }))).toEqual([
    { kind: "anchor", index: 0 },
    { kind: "keepalive", index: 0 },
  ])
})
