import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  OwnerRawSink,
} from "~/lib/pipeline/delivery/types"
import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
} from "~/lib/pipeline/types"

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  createGenerationWireIndexAllocator,
  createGenerationWireState,
  isAnthropicContentBlockStart,
  isAnthropicMessageStart,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { createRecoverySinkSupervisor } from "~/lib/pipeline/generation/recovery-sink-supervisor"
import { createClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"

function frame(type: string, extra: Record<string, unknown> = {}): ClientFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) }
}

function messageStart(id: string): ClientFrame {
  return frame("message_start", { message: { id } })
}

function contentBlockStart(index: number): ClientFrame {
  return frame("content_block_start", { index, content_block: { type: "text", text: "" } })
}

function hooks(): AnchorHooks {
  return {
    isMessageStart: isAnthropicMessageStart,
    isContentBlockStart: isAnthropicContentBlockStart,
    startFrame: anchorStartFrame,
    stopFrame: anchorStopFrame,
    deltaFrame: anchorDeltaFrame,
    syntheticMessageStart: syntheticMessageStartFrame,
    remap: remapAnthropicBlockIndex,
  }
}

function anchorState(): AnchorState {
  return {
    wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
    injected: false,
    contentAnchorInjected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
}

function key(value: ClientFrame): string {
  const payload = JSON.parse(value.data as string) as { type: string; index?: number }
  return typeof payload.index === "number" ? `${payload.type}@${payload.index}` : payload.type
}

function harness() {
  const written: Array<ClientFrame> = []
  const methods: Array<string> = []
  const raw: OwnerRawSink = {
    write(value) {
      methods.push("write")
      written.push(value)
      return Promise.resolve()
    },
    writeAnchor(value) {
      methods.push("writeAnchor")
      written.push(value)
      return Promise.resolve()
    },
    writeKeepalive(value) {
      methods.push("writeKeepalive")
      written.push(value)
      return Promise.resolve()
    },
    writeSyntheticEnvelope(value) {
      methods.push("writeSyntheticEnvelope")
      written.push(value)
      return Promise.resolve()
    },
    close() {
      methods.push("close")
    },
    finalize() {
      methods.push("finalize")
    },
  }
  const state = anchorState()
  const delivery = createDownstreamDeliverySession({ sink: raw, wireState: state.wireState, legacyAnchorMirror: state })
  const supervisor = createRecoverySinkSupervisor(delivery.clientSink)
  const persistentSink = makeReconcilingSink(supervisor.sink, state, hooks(), delivery.allocationPort)
  return {
    written,
    methods,
    state,
    delivery,
    supervisor,
    persistentSink,
    reset() {
      written.length = 0
      methods.length = 0
    },
  }
}

async function injectEnvelope(h: ReturnType<typeof harness>, id: string): Promise<void> {
  h.state.injected = true
  h.state.messageStartForwarded = true
  await h.delivery.writeScaffold([
    createClientFrameEnvelope(messageStart(id), {
      sequence: 0,
      observedAtMonotonic: 0,
      provenance: { kind: "synthetic", syntheticKind: "synthetic-message-start" },
    }),
  ])
}

async function injectOpenAnchor(h: ReturnType<typeof harness>): Promise<void> {
  await injectEnvelope(h, "synthetic-anchor")
  h.state.contentAnchorInjected = true
  h.state.anchorBlockOpen = true
  const leg = await h.delivery.allocationPort.beginLeg("primary", { candidateId: "primary", dispatchId: "primary-dispatch" })
  if (!leg.ok) throw new Error(`begin leg failed: ${leg.reason}`)
  const allocated = await h.delivery.allocationPort.allocateAndWriteAnchor(({ wireIndex, envelope }) => [
    envelope.anchor(anchorStartFrame(wireIndex)),
    envelope.keepalive(anchorDeltaFrame(wireIndex)),
  ])
  if (!allocated.ok) throw new Error(`anchor allocation failed: ${allocated.reason}`)
}

describe("one persistent live-reconcile sink across attempts", () => {
  test("no hooks: the original sink carries first-attempt and fresh-attempt frames unchanged", async () => {
    const written: Array<ClientFrame> = []
    const raw: OwnerRawSink = { write: (value) => (written.push(value), Promise.resolve()) }
    const delivery = createDownstreamDeliverySession({ sink: raw })
    const firstAttemptPing = frame("ping")
    const freshMessageStart = messageStart("msg_fresh_no_hooks")
    const freshBlockStart = contentBlockStart(0)

    await delivery.clientSink.write(firstAttemptPing)
    await delivery.clientSink.write(freshMessageStart)
    await delivery.clientSink.write(freshBlockStart)

    expect(written).toEqual([firstAttemptPing, freshMessageStart, freshBlockStart])
  })

  test("hooks exist but no scaffold was injected: both attempts pass through and message_start is recorded", async () => {
    const h = harness()
    await h.persistentSink.write(frame("ping"))
    await h.persistentSink.write(messageStart("msg_fresh_uninjected"))
    await h.persistentSink.write(contentBlockStart(0))

    expect(h.written.map(key)).toEqual(["ping", "message_start", "content_block_start@0"])
    expect(h.state.messageStartForwarded).toBe(true)
  })

  test("injected envelope without an open anchor drops the fresh duplicate and preserves its block index", async () => {
    const h = harness()
    await injectEnvelope(h, "synthetic-envelope")
    h.reset()
    await h.persistentSink.write(messageStart("msg_fresh_enveloped"))
    await h.persistentSink.write(contentBlockStart(0))

    expect(h.written.map(key)).toEqual(["content_block_start@0"])
    expect(h.state.anchorClosed).toBe(false)
  })

  test("injected open anchor preserves one decorated sink across an attempt boundary", async () => {
    const h = harness()
    await injectOpenAnchor(h)
    h.persistentSink.close?.()
    await h.persistentSink.finalize?.()
    expect(h.methods).not.toContain("close")
    expect(h.methods).not.toContain("finalize")

    h.reset()
    await h.persistentSink.write(messageStart("msg_fresh_empty_text"))
    await h.persistentSink.write(contentBlockStart(0))

    expect(h.written.map(key)).toEqual(["content_block_stop@0", "content_block_start@1"])
    expect(h.methods).toEqual(["writeAnchor", "write"])
    expect(h.state.anchorClosed).toBe(true)

    await h.supervisor.settleFinal()
    expect(h.methods).toEqual(["writeAnchor", "write", "close", "finalize"])
  })

  test("a fresh terminal error closes the open anchor exactly once before terminal frames", async () => {
    const h = harness()
    await injectOpenAnchor(h)
    h.reset()
    await h.persistentSink.write(messageStart("msg_fresh_failed"))
    await h.persistentSink.write(frame("error", { error: { type: "api_error", message: "fresh recovery failed" } }))
    await h.persistentSink.write(frame("message_stop"))

    expect(h.written.map(key)).toEqual(["content_block_stop@0", "error", "message_stop"])
    expect(h.methods).toEqual(["writeAnchor", "write", "write"])
    expect(h.methods.filter((method) => method === "writeAnchor")).toHaveLength(1)
    expect(h.state.anchorClosed).toBe(true)
  })
})
