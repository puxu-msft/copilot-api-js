import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientSink } from "~/lib/pipeline/types"

import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { isClientContentFrame } from "~/lib/pipeline/request-timing"
import { shouldAttemptPreContentRecovery } from "~/routes/messages/precontent-recovery-gate"

function deliveryWithoutContent() {
  return { hasEmittedRealClientContent: false }
}

function throwingUnreadInputs(): {
  config: { enabled: boolean }
  session: { hasEmittedRealClientContent: boolean }
} {
  return {
    config: {
      get enabled(): boolean {
        throw new Error("abort classification must short-circuit config")
      },
    },
    session: {
      get hasEmittedRealClientContent(): boolean {
        throw new Error("abort classification must short-circuit semantic-content state")
      },
    },
  }
}

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

describe("shouldAttemptPreContentRecovery", () => {
  test("deterministic HTTP and network failures recover when enabled before semantic content", () => {
    for (const kind of ["http-error", "network-error"] as const) {
      expect(
        shouldAttemptPreContentRecovery({
          failure: { kind },
          session: deliveryWithoutContent(),
          config: { enabled: true },
        }),
      ).toBe(true)
    }
  })

  test("client abort is excluded with highest-priority short-circuit", () => {
    const { config, session } = throwingUnreadInputs()

    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "abort", clientAborted: true, reaperAborted: true },
        session,
        config,
      }),
    ).toBe(false)
  })

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

  test("disabled runtime config excludes deterministic upstream failures", () => {
    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "http-error" },
        session: deliveryWithoutContent(),
        config: { enabled: false },
      }),
    ).toBe(false)
  })

  test("reaper cancellation is deliberately excluded to avoid killing legitimate long thinking", () => {
    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "abort", clientAborted: false, reaperAborted: true },
        session: deliveryWithoutContent(),
        config: { enabled: true },
      }),
    ).toBe(false)
  })

  test("header-wait timeout is deliberately excluded to avoid killing legitimate long thinking", () => {
    expect(
      shouldAttemptPreContentRecovery({
        failure: { kind: "abort", clientAborted: false, reaperAborted: false },
        session: deliveryWithoutContent(),
        config: { enabled: true },
      }),
    ).toBe(false)
  })
})
