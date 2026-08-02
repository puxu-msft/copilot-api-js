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
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { StreamClientAbortError } from "~/lib/stream"

const hooks = (synthetic = true): AnchorHooks => ({
  isMessageStart: () => false,
  isContentBlockStart: () => false,
  startFrame: anchorStartFrame,
  stopFrame: anchorStopFrame,
  deltaFrame: anchorDeltaFrame,
  ...(synthetic && { syntheticMessageStart: syntheticMessageStartFrame }),
  remap: remapAnthropicBlockIndex,
})

function setup(sink: ClientSink, injected = false) {
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const state: AnchorState = {
    wireState,
    injected,
    contentAnchorInjected: false,
    messageStartForwarded: injected,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  return { state, deliverySink: delivery.clientSink }
}

function injector(state: AnchorState, deliverySink: ClientSink, anchor: AnchorHooks) {
  return makeSyntheticAnchorInjector({
    anchor,
    state,
    getSink: () => deliverySink,
    resolvedName: "claude-test",
    reqId: "mirror",
    independentContentLatch: true,
  })
}

test("an unsatisfied independent-content precondition leaves its latch untouched", async () => {
  const { state, deliverySink } = setup({ write: async () => {}, close() {} })
  expect(await injector(state, deliverySink, hooks(false))()).toBe(false)
  expect(state.contentAnchorInjected).toBe(false)
  expect(state.injected).toBe(false)
  expect(state.anchorBlockOpen).toBe(false)
})

test("a pre-commit owner throw restores every legacy mirror flag", async () => {
  const writes: Array<ClientFrame> = []
  const sink: ClientSink = {
    async write(frame) {
      writes.push(frame)
    },
    async writeAnchor(frame) {
      writes.push(frame)
    },
    close() {},
  }
  const { state, deliverySink } = setup(sink)
  state.capturedMessageStart = { event: "message_start", data: '{"type":"message_start"}' }

  await expect(injector(state, deliverySink, hooks())()).rejects.toThrow("active leg")
  expect(state.wireState.allocator.nextAnchorIndex()).toBe(0)
  expect(state.wireState.allocator.anchorsOpened()).toBe(0)
  expect(state.wireState.openAnchorIndex).toBeUndefined()
  expect(state.contentAnchorInjected).toBe(false)
  expect(state.injected).toBe(false)
  expect(state.messageStartForwarded).toBe(false)
  expect(state.anchorBlockOpen).toBe(false)
  expect(writes).toEqual([])
})

test("a post-commit abort preserves irreversible anchor mirror state", async () => {
  let writes = 0
  const sink: ClientSink = {
    async write() {},
    async writeAnchor() {
      if (++writes === 2) throw new StreamClientAbortError()
    },
    async writeKeepalive() {
      throw new StreamClientAbortError()
    },
    close() {},
  }
  const { state, deliverySink } = setup(sink, true)
  state.capturedMessageStart = { event: "message_start", data: '{"type":"message_start"}' } as ClientFrame

  expect(await injector(state, deliverySink, hooks())()).toBe(false)
  expect(state.wireState.allocator.anchorsOpened()).toBe(1)
  expect(state.wireState.openAnchorIndex).toBe(0)
  expect(state.contentAnchorInjected).toBe(true)
  expect(state.injected).toBe(true)
  expect(state.anchorBlockOpen).toBe(true)
})
