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
import { getHistory } from "~/lib/history"
import { drainV3Writer } from "~/lib/history/v3/store"
import { setModels } from "~/lib/models/cache"
import { setDeliverySessionTestHooksForTests } from "~/lib/pipeline/delivery/session"
import { setStateForTests } from "~/lib/state"
import {
  //
  StreamClientAbortError,
  StreamShutdownError,
} from "~/lib/stream"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  jsonDeltaFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
  toolBlockStartFrame,
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

async function request(
  app: Awaited<ReturnType<(typeof import("../../helpers/test-app"))["createFullTestApp"]>>,
  sessionId: string,
  model = MODEL,
): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "recover" }], max_tokens: 64, stream: true }),
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

  // Task 5 mode/mount coverage SSOT. Each row drives the actual heartbeat clock before P fails;
  // the expected first recovery-visible frame encodes the frozen three-mode wire contract.
  test.each([
    { mode: "ping" as const, mount: "pre-ready" as const, injectedAnchor: false, expectedFirstRealIndex: 0 },
    { mode: "enveloped_ping" as const, mount: "pre-ready" as const, injectedAnchor: false, expectedFirstRealIndex: 0 },
    { mode: "empty_text" as const, mount: "pre-ready" as const, injectedAnchor: true, expectedFirstRealIndex: 1 },
  ])("pre-ready mode=$mode emits the recovery success wire contract", async ({ mode, mount, injectedAnchor, expectedFirstRealIndex }) => {
    const clock = new FakeClock()
    let firstFetchStarted!: () => void
    const firstFetchStartedP = new Promise<void>((resolve) => (firstFetchStarted = resolve))
    let releasePrimary!: () => void
    const primaryP = new Promise<Response>((resolve) => {
      releasePrimary = () => resolve(new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `primary ${mode} failed` } }), { status: 529 }))
    })
    let calls = 0

    clock.install()
    try {
      setStateForTests({ streamCommitAfterSec: 2, streamKeepalivePingSec: 2, streamKeepaliveMode: mode, maxReactiveRetries: 0 })
      applyFetchMock(
        mock(() => {
          calls += 1
          if (calls === 1) firstFetchStarted()
          return calls === 1 ? primaryP : Promise.resolve(createSseResponse(completeFrames(`msg_recovery_${mode}`)))
        }),
      )
      const { createFullTestApp } = await import("../../helpers/test-app")
      const responseP = request(createFullTestApp(), `precontent-mode-${mode}-${mount}`)
      await firstFetchStartedP
      await clock.advance(4_000)
      await drain()
      releasePrimary()
      const text = await (await responseP).text()
      const types = frameTypesInOrder(text)

      expect(calls).toBe(2)
      expect(types.filter((type) => type === "message_start")).toHaveLength(1)
      expect(types.filter((type) => type === "message_stop")).toHaveLength(1)
      const blockIndices = [...text.matchAll(/"index":(\d+)/g)].map((match) => Number(match[1]))
      expect(blockIndices.at(-1)).toBe(expectedFirstRealIndex)
      if (mode === "ping") expect(types.filter((type) => type === "ping").length).toBeGreaterThan(0)
      if (mode === "enveloped_ping") expect(types.indexOf("message_start")).toBeGreaterThan(types.indexOf("ping"))
      if (injectedAnchor) {
        expect(blockIndices[0]).toBe(0)
        expect(types.indexOf("content_block_stop")).toBeLessThan(types.lastIndexOf("content_block_start"))
      } else {
        expect(blockIndices[0]).toBe(0)
      }
      await drainV3Writer()
      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: `precontent-mode-${mode}-${mount}` }).entries[0]
      expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "winner", dispatchVerdict: "committed" })
    } finally {
      clock.restore()
    }
  })

  test("pre-ready 529 exhausts primary retry budget then publishes the complete direct recovery as winner", async () => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "pre-ready primary died" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_pre_ready_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-pre-ready-evaluate-only")
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).toContain("msg_pre_ready_recovery")
    expect(dataFramesOfType(text, "error")).toHaveLength(0)

    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-pre-ready-evaluate-only" }).entries[0]
    expect(entry?.attempts).toHaveLength(2)
    expect(entry?.attempts?.[0]).toMatchObject({ candidateRole: "primary", candidateVerdict: "failed", dispatchVerdict: "failed" })
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "winner", dispatchVerdict: "committed" })
  })

  test("non-complete direct recovery is discarded and preserves the primary terminal", async () => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "pre-ready primary died" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_truncated_recovery").slice(0, -2)))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-pre-ready-noncomplete")
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain("msg_truncated_recovery")
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "Failed to create messages" })

    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-pre-ready-noncomplete" }).entries[0]
    expect(entry?.attempts).toHaveLength(2)
    expect(entry?.attempts?.[0]).toMatchObject({ candidateRole: "primary", candidateVerdict: "failed", dispatchVerdict: "failed" })
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
  })

  test.each([
    [
      "upstream H2 error",
      "msg_recovery_h2_fallback",
      () =>
        createSseResponse([
          messageStartFrame({ id: "msg_recovery_h2_fallback", model: MODEL, inputTokens: 5 }),
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "recovery H2 failure" } })}\n\n`,
        ]),
    ],
    ["clean EOF truncation", "msg_recovery_truncated_fallback", () => createSseResponse(completeFrames("msg_recovery_truncated_fallback").slice(0, -2))],
    [
      "contentless refusal",
      "msg_recovery_refusal_fallback",
      () =>
        createSseResponse([
          messageStartFrame({ id: "msg_recovery_refusal_fallback", model: MODEL, inputTokens: 5 }),
          messageDeltaFrame({ stopReason: "refusal", outputTokens: 0 }),
          MESSAGE_STOP_FRAME,
          DONE_FRAME,
        ]),
    ],
  ])("pre-ready recovery %s is discarded once and retains the primary terminal", async (_kind, recoveryId, recoveryResponse) => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary recovery fallback" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(recoveryResponse())
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), `precontent-pre-ready-${_kind}`)
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain(recoveryId)
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "Failed to create messages" })
    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: `precontent-pre-ready-${_kind}` }).entries[0]
    expect(entry?.attempts?.[0]).toMatchObject({ candidateRole: "primary", candidateVerdict: "failed", dispatchVerdict: "failed" })
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
  })

  test("pre-ready unrepairable recovery tool input is discarded locally and preserves the primary terminal", async () => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0, toolRepairMalformedInput: ["tags", "jsonrepair"] })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary tool fallback" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(
          createSseResponse([
            messageStartFrame({ id: "msg_recovery_unrepairable", model: MODEL, inputTokens: 5 }),
            toolBlockStartFrame(0, "toolu_recovery_unrepairable", "TodoWrite"),
            jsonDeltaFrame(0, '{"todos":1,,,}'),
            blockStopFrame(0),
            messageDeltaFrame({ stopReason: "tool_use", outputTokens: 1 }),
            MESSAGE_STOP_FRAME,
            DONE_FRAME,
          ]),
        )
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const text = await (await request(createFullTestApp(), "precontent-pre-ready-unrepairable")).text()

    expect(calls).toBe(2)
    expect(text).not.toContain("msg_recovery_unrepairable")
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "Failed to create messages" })
    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-pre-ready-unrepairable" }).entries[0]
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
  })

  test("pre-C9 recovery publication rejection discards R and retains the primary terminal", async () => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    setDeliverySessionTestHooksForTests({
      onBeforeRecoveryBatchCommit() {
        throw new Error("publication preflight rejected")
      },
    })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary preflight fallback" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_preflight_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-publication-preflight")
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain("msg_preflight_recovery")
    expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "Failed to create messages" })
    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-publication-preflight" }).entries[0]
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
  })

  test("pre-ready wire-torn recovery does not fall back to the primary error", async () => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    let rejectRecoveryCandidate = true
    setDeliverySessionTestHooksForTests({
      onWrite(entry) {
        if (entry.provenance.kind === "candidate" && rejectRecoveryCandidate) {
          rejectRecoveryCandidate = false
          throw new Error("recovery wire torn")
        }
      },
      onCloseAnchor() {
        throw new Error("recovery owner anchor close rejected")
      },
    })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary must not surface" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_torn_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-publication-torn")
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain("primary must not surface")
    expect(text).toContain("Recovery publication failed")
    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-publication-torn" }).entries[0]
    expect(entry?._index?.derived?.failureReason).toContain("recovery wire torn")
    expect(entry?._index?.derived?.failureReason).toContain("recovery owner anchor close rejected")
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
    setDeliverySessionTestHooksForTests(undefined)
  })

  test("post-C9 client-gone publication aborts without appending the primary terminal", async () => {
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    setDeliverySessionTestHooksForTests({
      onWrite() {
        throw new StreamClientAbortError()
      },
    })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary abort fallback" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_client_gone_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-publication-client-gone")
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain("primary abort fallback")
    expect(text).not.toContain("msg_client_gone_recovery")
    expect(dataFramesOfType(text, "error")).toHaveLength(0)
  })

  test("ready-live recovery resumes the suspended heartbeat while evaluation waits, then publishes its batch without interleaving", async () => {
    const clock = new FakeClock()
    let recoveryFirstPull!: () => void
    const recoveryFirstPullP = new Promise<void>((resolve) => (recoveryFirstPull = resolve))
    let releaseRecovery!: () => void
    const recoveryReleaseP = new Promise<void>((resolve) => (releaseRecovery = resolve))
    let calls = 0

    clock.install()
    try {
      setStateForTests({ streamCommitAfterSec: 0, streamKeepalivePingSec: 2, streamKeepaliveMode: "ping", maxReactiveRetries: 0 })
      applyFetchMock(
        mock(() => {
          calls += 1
          if (calls === 1)
            return Promise.resolve(
              createSseResponseThenError(
                [messageStartFrame({ id: "msg_primary_before_recovery", model: MODEL, inputTokens: 5 })],
                tagTransportError(new Error("primary heartbeat fallback"), "refused-stream"),
              ),
            )
          const encoder = new TextEncoder()
          let released = false
          return Promise.resolve(
            new Response(
              new ReadableStream({
                async pull(controller) {
                  recoveryFirstPull()
                  if (released) return
                  released = true
                  await recoveryReleaseP
                  for (const frame of completeFrames("msg_recovery_after_heartbeat")) controller.enqueue(encoder.encode(frame))
                  controller.close()
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      )
      const { createFullTestApp } = await import("../../helpers/test-app")
      const responseP = request(createFullTestApp(), "precontent-recovery-heartbeat")

      await recoveryFirstPullP
      await drain()
      await clock.advance(2_001)
      await drain()
      await clock.advance(2_001)
      await drain()
      releaseRecovery()
      const text = await (await responseP).text()

      expect(calls).toBe(2)
      // The resumed timer arms from the recovery-start clock, so this controlled 4s window emits exactly one cadence ping before R's atomic batch.
      expect(frameTypesInOrder(text).filter((type) => type === "ping")).toHaveLength(1)
      const frameTypes = frameTypesInOrder(text)
      expect(frameTypes.slice(frameTypes.lastIndexOf("ping") + 1)).toEqual([
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ])
    } finally {
      clock.restore()
    }
  })

  test("commit rejection after full recovery publication preserves R wire and records its cleanup error", async () => {
    const quiesceError = new Error("recovery commit quiesce rejected")
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    let exchanges = 0
    let recoveryQuiesceObserved = false
    const { setUpstreamHookForTests } = await import("~/lib/pipeline/hooks/loader")
    setUpstreamHookForTests({
      async exchange(_wire, _env, next) {
        const exchangeNumber = ++exchanges
        const upstream = await next()
        if (exchangeNumber !== 2) return upstream

        const quiesced = Promise.reject(quiesceError)
        void quiesced.catch(() => {
          recoveryQuiesceObserved = true
        })
        return Object.assign(upstream, {
          lifecycle: {
            cancel() {},
            async dispose() {
              return { quiesced: true, connectionReusable: false }
            },
            quiesced,
          },
        })
      },
    })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary commit fallback" } }), { status: 529 }),
                ),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_commit_rejected_recovery")))
      }),
    )
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const response = await request(createFullTestApp(), "precontent-publication-commit-rejected")
      const text = await response.text()

      expect(calls).toBe(2)
      expect(exchanges).toBe(2)
      expect(recoveryQuiesceObserved).toBeTrue()
      expect(text).toContain("msg_commit_rejected_recovery")
      expect(text).not.toContain("primary commit fallback")
      // The full R wire is already terminal; no primary fallback frame may append after failed settlement.
      expect(dataFramesOfType(text, "error")).toHaveLength(0)
      await drainV3Writer()
      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-publication-commit-rejected" }).entries[0]
      expect(entry?._index?.derived?.failureReason).toBe("recovery commit quiesce rejected")
      expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
    } finally {
      setUpstreamHookForTests(undefined)
    }
  })

  test("translated pre-ready recovery disposal failure closes the unconsumed candidate and preserves primary terminal", async () => {
    const translatedModel = "claude-opus-4.8@responses"
    const cleanupError = new Error("translated recovery dispose rejected")
    setStateForTests({ streamCommitAfterSec: 0.001, maxReactiveRetries: 0 })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
    let exchanges = 0
    const { setUpstreamHookForTests } = await import("~/lib/pipeline/hooks/loader")
    setUpstreamHookForTests({
      async exchange(_wire, _env, next) {
        exchanges += 1
        const upstream = await next()
        if (exchanges === 1) return upstream
        return Object.assign(upstream, {
          lifecycle: {
            cancel() {},
            async dispose() {
              throw cleanupError
            },
            quiesced: Promise.resolve(),
          },
        })
      },
    })
    let fetchCalls = 0
    applyFetchMock(
      mock(() => {
        fetchCalls += 1
        if (fetchCalls === 1)
          return new Promise<Response>((resolve) => {
            setTimeout(
              () => resolve(new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "primary rejected" } }), { status: 529 })),
              10,
            )
          })
        return Promise.resolve(createSseResponse(completeFrames("msg_translated_recovery")))
      }),
    )
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const response = await request(createFullTestApp(), "precontent-translated-dispose-failure", translatedModel)
      const text = await response.text()

      expect(exchanges).toBe(2)
      expect(fetchCalls).toBe(2)
      expect(text).not.toContain("msg_translated_recovery")
      expect(dataFramesOfType(text, "error")[0]?.error).toMatchObject({ message: "Failed to create responses" })
      await drainV3Writer()
      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-translated-dispose-failure" }).entries[0]
      expect(entry?._index?.derived?.failureReason).toBe("Failed to create responses")
      expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
    } finally {
      setUpstreamHookForTests(undefined)
    }
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

  test("ready live stream-error publishes the complete direct recovery as winner", async () => {
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
    // The primary already opened the client turn before its stream died; recovery's duplicate message_start is dropped.
    expect(text).toContain("msg_primary")
    expect(text).not.toContain("msg_ready_recovery")
    expect(text).toContain("recovered response")
    expect(dataFramesOfType(text, "error")).toHaveLength(0)

    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-ready-evaluate-only" }).entries[0]
    expect(entry?.attempts).toHaveLength(2)
    expect(entry?.attempts?.[0]?.upstreamResponse?.success).toBe(false)
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "winner", dispatchVerdict: "committed" })
  })

  test("ready-live commit rejection records only the commit quiesce failure before request finalization", async () => {
    const quiesceError = new Error("ready recovery commit quiesce rejected")
    setDeliverySessionTestHooksForTests(undefined)
    let exchanges = 0
    let recoveryQuiesceObserved = false
    const { setUpstreamHookForTests } = await import("~/lib/pipeline/hooks/loader")
    setUpstreamHookForTests({
      async exchange(_wire, _env, next) {
        const exchangeNumber = ++exchanges
        const upstream = await next()
        if (exchangeNumber !== 2) return upstream

        const quiesced = Promise.reject(quiesceError)
        void quiesced.catch(() => {
          recoveryQuiesceObserved = true
        })
        return Object.assign(upstream, {
          lifecycle: {
            cancel() {},
            async dispose() {
              return { quiesced: true, connectionReusable: false }
            },
            quiesced,
          },
        })
      },
    })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve(
            createSseResponseThenError(
              [messageStartFrame({ id: "msg_ready_commit_primary", model: MODEL, inputTokens: 5 })],
              tagTransportError(new Error("ready primary commit fallback"), "refused-stream"),
            ),
          )
        return Promise.resolve(createSseResponse(completeFrames("msg_ready_commit_recovery")))
      }),
    )
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const response = await request(createFullTestApp(), "precontent-ready-commit-rejected")
      const text = await response.text()

      expect(calls).toBe(2)
      expect(exchanges).toBe(2)
      expect(recoveryQuiesceObserved).toBeTrue()
      expect(text).toContain("msg_ready_commit_primary")
      expect(text).toContain("recovered response")
      expect(text).not.toContain("ready primary commit fallback")
      expect(dataFramesOfType(text, "error")).toHaveLength(0)
      await drainV3Writer()
      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-ready-commit-rejected" }).entries[0]
      expect(entry?._index?.derived?.failureReason).toBe("ready recovery commit quiesce rejected")
      expect(entry?.attempts?.[0]).toMatchObject({ candidateRole: "primary", candidateVerdict: "failed", dispatchVerdict: "discarded" })
      expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
      expect(entry?.attempts?.[1]?.upstreamResponse?.success).toBe(false)
    } finally {
      setUpstreamHookForTests(undefined)
      setDeliverySessionTestHooksForTests(undefined)
    }
  })

  test("ready-live wire-torn recovery aggregates terminal write rejection without falling back to the primary error", async () => {
    let writes = 0
    setDeliverySessionTestHooksForTests({
      onWrite() {
        const write = ++writes
        if (write === 2) throw new Error("ready recovery wire torn")
        if (write === 3) throw new Error("ready recovery terminal write rejected")
      },
    })
    let calls = 0
    applyFetchMock(
      mock(() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve(
            createSseResponseThenError(
              [messageStartFrame({ id: "msg_ready_primary", model: MODEL, inputTokens: 5 })],
              tagTransportError(new Error("ready primary must not surface"), "refused-stream"),
            ),
          )
        return Promise.resolve(createSseResponse(completeFrames("msg_ready_torn_recovery")))
      }),
    )

    const { createFullTestApp } = await import("../../helpers/test-app")
    const response = await request(createFullTestApp(), "precontent-ready-publication-torn")
    const text = await response.text()

    expect(calls).toBe(2)
    expect(text).not.toContain("ready primary must not surface")
    expect(text).not.toContain("msg_ready_torn_recovery")
    expect(dataFramesOfType(text, "error")).toHaveLength(0)
    await drainV3Writer()
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "precontent-ready-publication-torn" }).entries[0]
    expect(entry?._index?.derived?.failureReason).toContain("Recovery publication settlement failed")
    expect(entry?._index?.derived?.failureReason).toContain("ready recovery wire torn")
    expect(entry?._index?.derived?.failureReason).toContain("ready recovery terminal write rejected")
    expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "failed", dispatchVerdict: "failed" })
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
