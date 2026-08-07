/**
 * Task 4.3b — live pre-content recovery handler wiring.
 *
 * These tests exercise the real /v1/messages handler rather than driver APIs: the oracle is the
 * client-visible SSE turn plus the physical dispatch count. A delivery that never receives a real
 * content frame may make exactly one fresh recovery dispatch; the original failure never reaches
 * the client when that recovery succeeds.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { tagTransportError } from "~/lib/error/transport-reason"
import { setModels } from "~/lib/models/cache"
import { setDeliverySessionTestHooksForTests } from "~/lib/pipeline/delivery/session"
import { setStateForTests } from "~/lib/state"
import { StreamShutdownError } from "~/lib/stream"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
} from "../../helpers/anthropic-frames"
import { mockModel } from "../../helpers/factories"
import { FakeClock } from "../../helpers/fake-clock"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenError,
  dataFramesOfType,
  frameTypesInOrder,
} from "../../helpers/sse"

const MODEL = "claude-opus-4.8"

function completeFrames(id: string): Array<string> {
  return [
    messageStartFrame({ id, model: MODEL, inputTokens: 5 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "recovered response"),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "end_turn", outputTokens: 2 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

async function request(app: Awaited<ReturnType<(typeof import("../../helpers/test-app"))["createFullTestApp"]>>, sessionId: string): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "recover" }], max_tokens: 64, stream: true }),
  })
}

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("Task 4.3b pre-content recovery matrix", () => {
  useIsolatedRuntime()
  beforeEach(() => {
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamCommitAfterSec: 0,
      streamKeepalivePingSec: 0,
      streamKeepaliveMode: "ping",
      preContentRecovery: { enabled: true },
      protectStreamingGeneration: false,
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("COMMIT HTTP failure before content makes exactly one fresh dispatch and exposes one coherent turn", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve(
            new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary unavailable" } }), { status: 529 }),
          )
        return Promise.resolve(createSseResponse(completeFrames("msg_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-pre-ready-success")
    expect(response.status).toBe(200)
    const text = await response.text()

    expect(calls).toBe(2)
    const types = frameTypesInOrder(text)
    expect(types.filter((type) => type === "message_start")).toHaveLength(1)
    expect(types.filter((type) => type === "message_delta")).toHaveLength(1)
    expect(types.filter((type) => type === "message_stop")).toHaveLength(1)
    expect(dataFramesOfType(text, "error")).toHaveLength(0)
    expect(types.indexOf("message_delta")).toBeLessThan(types.indexOf("message_stop"))
  })

  test("COMMIT nonretryable HTTP 418 before content keeps the primary terminal and makes no fresh dispatch", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        return Promise.resolve(
          new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "primary rejected" } }), { status: 418 }),
        )
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-418-no-replay")
    expect(response.status).toBe(200)
    const text = await response.text()

    expect(calls).toBe(1)
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ type: "invalid_request_error", message: "Failed to create messages" })
  })

  test("shutdown-classified ready error is never replayed", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        return Promise.resolve(createSseResponseThenError([messageStartFrame({ id: "msg_shutdown", model: MODEL, inputTokens: 5 })], new StreamShutdownError()))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-shutdown-no-replay")
    const text = await response.text()

    expect(calls).toBe(1)
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ type: "overloaded_error" })
  })

  test.each([
    [
      "H2 event:error",
      () =>
        createSseResponse([
          messageStartFrame({ id: "msg_recovery_h2", model: MODEL, inputTokens: 5 }),
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "recovery H2 failure" } })}\n\n`,
        ]),
    ],
    [
      "thrown stream error",
      () => createSseResponseThenError([messageStartFrame({ id: "msg_recovery_throw", model: MODEL, inputTokens: 5 })], new Error("recovery throw")),
    ],
  ])("recovery %s stays off wire and primary error is the one terminal", async (_name, recoveryResponse) => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve(
            createSseResponseThenError(
              [messageStartFrame({ id: "msg_primary_failure", model: MODEL, inputTokens: 5 })],
              tagTransportError(new Error("primary refused stream"), "refused-stream"),
            ),
          )
        return Promise.resolve(recoveryResponse())
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), `precontent-recovery-terminal-${_name}`)
    const text = await response.text()
    const errors = dataFramesOfType(text, "error")

    expect(calls).toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toMatchObject({ message: "primary refused stream" })
    expect(text).not.toContain("recovery H2 failure")
    expect(text).not.toContain("recovery throw")
  })

  test("ready live stream-error evaluates one fresh dispatch without publishing candidate frames", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve(
            createSseResponseThenError(
              [messageStartFrame({ id: "msg_primary", model: MODEL, inputTokens: 5 })],
              tagTransportError(new Error("primary refused stream"), "refused-stream"),
            ),
          )
        return Promise.resolve(createSseResponse(completeFrames("msg_ready_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-ready-evaluate-only")
    expect(response.status).toBe(200)
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain("msg_ready_recovery")
    expect(dataFramesOfType(text, "error")).toHaveLength(1)
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "primary refused stream" })
  })

  test("unexpected handler failure never makes a fresh recovery dispatch", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        return Promise.resolve(createSseResponse(completeFrames("msg_handler_failure")))
      }),
    )

    const { setUpstreamHookForTests } = await import("~/lib/pipeline/hooks/loader")
    setUpstreamHookForTests({
      client: {
        outbound() {
          throw new Error("unexpected handler-side processing failure")
        },
      },
    })
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const response = await request(createFullTestApp(), "precontent-unexpected-no-recovery")
      const text = await response.text()

      expect(calls).toBe(1)
      expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "unexpected handler-side processing failure" })
    } finally {
      setUpstreamHookForTests(undefined)
    }
  })

  test("production network-classified sink write never makes a fresh recovery dispatch", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        return Promise.resolve(createSseResponse(completeFrames("msg_delivery_failure")))
      }),
    )
    setDeliverySessionTestHooksForTests({
      onWrite: () => Promise.reject(tagTransportError(new Error("production sink write rejected"), "refused-stream")),
    })
    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-delivery-sink-no-recovery")
    const text = await response.text()

    expect(calls).toBe(1)
    // The failed production delivery can make the client wire unavailable before an error terminator
    // is writable. Dispatch count is the recovery oracle: no fresh upstream candidate was opened.
    expect(text).not.toContain("msg_ready_recovery")
  })

  test("production delivery-owner failure at the committed anchor allocation never opens recovery", async () => {
    const clock = new FakeClock()
    let gateReached!: () => void
    const gateReachedP = new Promise<void>((resolve) => (gateReached = resolve))
    let openGate!: () => void
    const gateOpenP = new Promise<void>((resolve) => (openGate = resolve))
    let calls = 0
    const ownerOperations: Array<string> = []
    let injectOwnerFailure = true

    clock.install()
    try {
      setStateForTests({
        copilotToken: "test-token",
        accountType: "individual",
        vsCodeVersion: "1.100.0",
        responseHeaderTimeout: 0,
        streamIdleTimeout: 0,
        streamCommitAfterSec: 2,
        streamKeepalivePingSec: 2,
        streamKeepaliveMode: "empty_text",
        preContentRecovery: { enabled: true },
        protectStreamingGeneration: false,
      })
      applyFetchMock(
        mock(() => {
          calls += 1
          gateReached()
          return gateOpenP.then(() => createSseResponse(completeFrames("msg_owner_after_anchor")))
        }),
      )
      setDeliverySessionTestHooksForTests({
        onCommittedAllocation: (operation) => {
          ownerOperations.push(operation)
          if (injectOwnerFailure) {
            injectOwnerFailure = false
            return Promise.reject(tagTransportError(new Error("production owner rejected"), "refused-stream"))
          }
        },
      })
      const { createFullTestApp } = await import("../../helpers/test-app")
      const responseP = request(createFullTestApp(), "precontent-delivery-owner-no-recovery")
      await gateReachedP
      await clock.advance(2_000)
      await drain()
      const response = await responseP
      await clock.advance(2_500)
      await drain()
      expect(ownerOperations).toEqual(["allocate-anchor"])

      openGate()
      const text = await response.text()
      expect(calls).toBe(1)
      expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "[delivery] begin-leg cannot advance a torn wire transaction" })
      expect(text).not.toContain("msg_owner_after_anchor")
      expect(injectOwnerFailure).toBeFalse()
    } finally {
      clock.restore()
    }
  })

  test("production pre-wire beginLeg owner failure never opens recovery", async () => {
    let calls = 0
    let secondFetchStarted!: () => void
    const secondFetchStartedP = new Promise<void>((resolve) => (secondFetchStarted = resolve))
    const beginLegKinds: Array<string> = []
    const outcomes: Array<{ kind: "stream-error"; source: string }> = []
    let injectOwnerFailure = true
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 2) secondFetchStarted()
        return Promise.resolve(createSseResponse(completeFrames("msg_begin_leg_owner")))
      }),
    )
    setDeliverySessionTestHooksForTests({
      onBeginLeg: (kind) => {
        beginLegKinds.push(kind)
        if (injectOwnerFailure) {
          injectOwnerFailure = false
          return Promise.reject(tagTransportError(new Error("pre-wire owner rejected"), "refused-stream"))
        }
      },
      onResponseOutcome: (outcome) => outcomes.push(outcome),
    })
    const { createFullTestApp } = await import("../../helpers/test-app")
    const bodyCompletedP = request(createFullTestApp(), "precontent-begin-leg-owner-no-recovery").then(async (response) => {
      const text = await response.text()
      return { kind: "body-complete" as const, text }
    })
    const winner = await Promise.race([bodyCompletedP, secondFetchStartedP.then(() => ({ kind: "second-fetch" as const }))])

    expect(winner.kind).toBe("body-complete")
    expect(calls).toBe(1)
    expect(beginLegKinds).toEqual(["primary"])
    expect(outcomes.map(({ kind, source }) => ({ kind, source }))).toEqual([{ kind: "stream-error", source: "delivery-owner" }])
    if (winner.kind === "body-complete") {
      expect(dataFramesOfType(winner.text, "error")[0]?.error).toMatchObject({ message: "pre-wire owner rejected" })
      expect(winner.text).not.toContain("msg_begin_leg_owner")
    }
  })

  test("codec-render failures never make a fresh recovery dispatch", async () => {
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        return Promise.resolve(createSseResponse(completeFrames("msg_codec_failure")))
      }),
    )

    const { setUpstreamHookForTests } = await import("~/lib/pipeline/hooks/loader")
    setUpstreamHookForTests({
      client: {
        outbound() {
          throw new Error("client render hook failed")
        },
      },
    })
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const response = await request(createFullTestApp(), "precontent-codec-no-recovery")
      const text = await response.text()

      expect(calls).toBe(1)
      expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "client render hook failed" })
    } finally {
      setUpstreamHookForTests(undefined)
    }
  })
})
