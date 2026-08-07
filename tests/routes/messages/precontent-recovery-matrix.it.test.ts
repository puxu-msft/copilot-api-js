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

  test("ready live stream-error before content makes exactly one fresh dispatch and exposes one coherent turn", async () => {
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
    const app = createFullTestApp()
    const response = await request(app, "precontent-ready-success")
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
})
