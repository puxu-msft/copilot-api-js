import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientSink } from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { isClientContentFrame } from "~/lib/pipeline/request-timing"
import { shouldAttemptPreContentRecovery } from "~/routes/messages/precontent-recovery-gate"

function productionDelivery(): { sink: ClientSink; session: NonNullable<ReturnType<typeof getDownstreamDeliverySession>> } {
  const stream = { writeSSE: () => Promise.resolve() } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  const sink = makeDeliverySseSink(stream, {
    isRealContentFrame: (frame) => isClientContentFrame(frame, "anthropic"),
  })
  const session = getDownstreamDeliverySession(sink)
  if (!session) throw new Error("production delivery sink must expose its session")
  return { sink, session }
}

function realContentDelta(text: string) {
  return {
    event: "content_block_delta",
    data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
  }
}

const reconcileHooks = {
  isMessageStart: () => false,
  stopFrame: (index: number) => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) }),
  remap: (frame: Parameters<ClientSink["write"]>[0]) => frame,
}

describe("shouldAttemptPreContentRecovery delivery integration", () => {
  test("a delivered delta before content_block_stop belongs to continuation, not pre-content recovery", async () => {
    const { sink, session } = productionDelivery()
    await sink.write(realContentDelta("already delivered"))
    // Deliberately omit content_block_stop: boundary.result would still be empty here, while the delivery-level
    // hasEmittedRealClientContent signal has already flipped at client egress.

    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "network-error" },
        session,
        config: { enabled: true },
      }),
    ).toBe(false)
  })

  test("a decorated sink cannot resolve delivery state, so recovery must fail closed", async () => {
    const { sink: rawSink } = productionDelivery()
    const decorated = makeReconcilingSink(
      rawSink,
      {
        wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
        injected: false,
        messageStartForwarded: false,
        anchorBlockOpen: false,
        anchorClosed: false,
      },
      reconcileHooks,
    )
    await decorated.write(realContentDelta("already delivered through decorator"))
    const decoratedSession = getDownstreamDeliverySession(decorated)
    expect(decoratedSession).toBeUndefined()

    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "network-error" },
        // Exercise the runtime fail-closed guard against an untyped/wrong 4.3 caller; the public API rejects
        // this at compile time and requires resolving delivery from the raw sink.
        session: decoratedSession as never,
        config: { enabled: true },
      }),
    ).toBe(false)
  })
})
