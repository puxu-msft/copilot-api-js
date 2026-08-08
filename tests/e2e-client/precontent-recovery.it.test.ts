import Anthropic from "@anthropic-ai/sdk"
import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { tagTransportError } from "~/lib/error/transport-reason"
import { getHistory } from "~/lib/history"
import { drainV3Writer } from "~/lib/history/v3/store"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  createSseResponse,
  createSseResponseThenError,
} from "../helpers/sse"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"
import {
  //
  scriptedUpstream,
  sequencedUpstream,
} from "./harness/upstream-script"

const MODEL = "claude-opus-4.8"
const REQUEST = { model: MODEL, max_tokens: 64, messages: [{ role: "user" as const, content: "recover" }] }
const SESSION_HEADER = { "x-session-id": "sdk-precontent-recovery" }

function completeFrames(id: string, text: string): Array<string> {
  return [
    messageStartFrame({ id, model: MODEL, inputTokens: 5 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, text),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "end_turn", outputTokens: 2 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

function textOf(message: { content: ReadonlyArray<unknown> }): string {
  return message.content
    .flatMap((block) =>
      typeof block === "object" && block !== null && "type" in block && (block as { type?: string }).type === "text" ?
        [(block as { text?: string }).text ?? ""]
      : [],
    )
    .join("")
}

describe("@anthropic-ai/sdk 0.106.0 pre-content recovery", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  let client: Anthropic

  beforeAll(() => {
    proxy = serveInProcess()
    client = new Anthropic({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0, timeout: 5_000 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamCommitAfterSec: 0.001,
      streamKeepalivePingSec: 0,
      streamKeepaliveMode: "ping",
      maxReactiveRetries: 0,
      preContentRecovery: { enabled: true },
      protectStreamingGeneration: false,
      refusalSseRewrite: "refusal",
      recoverToolCallText: false,
      toolRepairMalformedInput: [],
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  test.each(["ping", "enveloped_ping", "empty_text"] as const)("ready-live %s recovery yields one coherent SDK message", async (mode) => {
    setStateForTests({ streamKeepaliveMode: mode, streamKeepalivePingSec: 0.001 })
    let calls = 0
    setUpstreamFetchForTests(async () => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        return createSseResponseThenError([], tagTransportError(new Error(`primary ${mode} failed`), "refused-stream"))
      }
      return createSseResponse(completeFrames(`msg_sdk_pre_ready_${mode}`, `${mode} recovered`))
    })

    const final = await client.messages.stream(REQUEST, { headers: SESSION_HEADER }).finalMessage()

    expect(calls).toBe(2)
    expect(final.stop_reason).toBe("end_turn")
    expect(final.usage.output_tokens).toBe(2)
    // The SDK sees a single completed message even when the proxy inserted and reconciled a synthetic prelude.
    expect(textOf(final)).toContain(`${mode} recovered`)
    if (mode === "ping") {
      await drainV3Writer()
      const entry = getHistory({ endpoint: "anthropic-messages", sessionId: SESSION_HEADER["x-session-id"] }).entries[0]
      expect(entry?.attempts?.[1]).toMatchObject({ candidateRole: "recovery", candidateVerdict: "winner", dispatchVerdict: "committed" })
    }
  })

  test("ready-live clean EOF before semantic content recovers one coherent SDK message", async () => {
    const upstream = sequencedUpstream([
      // `messageStartFrame()` is already a complete `event: ...\ndata: ...\n\n` SSE string;
      // `createSseResponse()` writes it verbatim, then closes the body after the live pump consumes it.
      () => createSseResponse([messageStartFrame({ id: "msg_sdk_ready_eof_primary", model: MODEL, inputTokens: 5 })]),
      () => createSseResponse(completeFrames("msg_sdk_ready_eof_recovery", "ready clean EOF recovered")),
    ])
    setUpstreamFetchForTests(upstream.handler)

    const final = await client.messages.stream(REQUEST).finalMessage()

    expect(upstream.callCount()).toBe(2)
    expect(final.stop_reason).toBe("end_turn")
    expect(textOf(final)).toBe("ready clean EOF recovered")
  })

  test("ready-live transport close recovers one coherent SDK message", async () => {
    const upstream = sequencedUpstream([
      () =>
        createSseResponseThenError(
          [messageStartFrame({ id: "msg_sdk_primary", model: MODEL, inputTokens: 5 })],
          tagTransportError(new Error("ready transport closed"), "refused-stream"),
        ),
      () => createSseResponse(completeFrames("msg_sdk_ready_recovery", "ready recovered")),
    ])
    setUpstreamFetchForTests(upstream.handler)

    const final = await client.messages.stream(REQUEST).finalMessage()

    expect(upstream.callCount()).toBe(2)
    expect(final.stop_reason).toBe("end_turn")
    expect(textOf(final)).toBe("ready recovered")
  })

  test("clean control remains one untouched exchange", async () => {
    const upstream = scriptedUpstream(() => createSseResponse(completeFrames("msg_sdk_control", "control response")))
    setUpstreamFetchForTests(upstream.handler)

    const final = await client.messages.stream(REQUEST).finalMessage()

    expect(upstream.callCount()).toBe(1)
    expect(final.stop_reason).toBe("end_turn")
    expect(textOf(final)).toBe("control response")
  })
})
