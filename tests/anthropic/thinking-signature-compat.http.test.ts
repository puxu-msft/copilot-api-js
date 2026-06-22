/**
 * End-to-end test for the thinking-signature compatibility shim on the
 * client-facing /v1/messages stream.
 *
 * Reproduces the real bug: a Copilot upstream emits an encrypted thinking block
 * as a single non-standard frame — `content_block_start {type:"thinking",
 * thinking:"", signature:S}` with NO trailing `signature_delta` — and a standard
 * client drops the signature (it only reads signatures from `signature_delta`),
 * echoing back a corrupt `{thinking:"", signature:""}` block on the next turn.
 *
 * These tests assert what the CLIENT actually receives (the forwarded SSE bytes)
 * across the three `thinking_signature_compat` modes.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

// Upstream stream: the non-standard embedded-signature thinking block (signature
// on content_block_start, NO signature_delta), then a text block, then close.
const EMBEDDED_SIG = "EoAQ-embedded-signature-3404"

function buildEmbeddedSigThinkingFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    })}\n\n`,
    // The non-standard frame: signature embedded directly on content_block_start.
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: EMBEDDED_SIG },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/v1/messages")) {
    return createSseResponse(buildEmbeddedSigThinkingFrames(payload.model ?? "claude-opus-4.8"))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(sessionId?: string): Promise<string> {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sessionId ? { "x-session-id": sessionId } : {}) },
    body: JSON.stringify({ model: "claude-opus-4.8", messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  return res.text()
}

/** Extract parsed `data:` JSON objects of a given event type from a forwarded SSE text. */
function dataFramesOfType(sse: string, type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const body = line.slice(6)
    if (body === "[DONE]") continue
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      if (obj.type === type) out.push(obj)
    } catch {
      // non-JSON keepalive — skip
    }
  }
  return out
}

describe("POST /v1/messages — thinking-signature compatibility shim", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel("claude-opus-4.8", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("default (signature_delta): client receives empty thinking start + a synthesized signature_delta", async () => {
    setStateForTests({ thinkingSignatureCompat: "signature_delta" })
    const sse = await streamRequest()

    // The thinking content_block_start the client gets must NOT carry the signature inline.
    const thinkingStarts = dataFramesOfType(sse, "content_block_start").filter((f) => (f.content_block as Record<string, unknown>).type === "thinking")
    expect(thinkingStarts).toHaveLength(1)
    expect((thinkingStarts[0].content_block as Record<string, unknown>).signature).toBe("")

    // A synthesized signature_delta carrying the signature must be present.
    const sigDeltas = dataFramesOfType(sse, "content_block_delta").filter((f) => (f.delta as Record<string, unknown>).type === "signature_delta")
    expect(sigDeltas).toHaveLength(1)
    expect((sigDeltas[0].delta as Record<string, unknown>).signature).toBe(EMBEDDED_SIG)
    expect(sigDeltas[0].index).toBe(0)

    // Text block still forwarded intact.
    expect(sse).toContain("Answer.")
  })

  test("redacted_thinking: client receives a redacted_thinking block carrying data=signature", async () => {
    setStateForTests({ thinkingSignatureCompat: "redacted_thinking" })
    const sse = await streamRequest()

    const starts = dataFramesOfType(sse, "content_block_start")
    const redacted = starts.filter((f) => (f.content_block as Record<string, unknown>).type === "redacted_thinking")
    expect(redacted).toHaveLength(1)
    expect((redacted[0].content_block as Record<string, unknown>).data).toBe(EMBEDDED_SIG)
    // No plain thinking start leaks through, and no signature_delta synthesized in this mode.
    expect(starts.some((f) => (f.content_block as Record<string, unknown>).type === "thinking")).toBe(false)
    expect(dataFramesOfType(sse, "content_block_delta").some((f) => (f.delta as Record<string, unknown>).type === "signature_delta")).toBe(false)
  })

  test("false: passthrough — client receives the raw non-standard frame unchanged (reproduces the bug)", async () => {
    setStateForTests({ thinkingSignatureCompat: false })
    const sse = await streamRequest()

    const thinkingStarts = dataFramesOfType(sse, "content_block_start").filter((f) => (f.content_block as Record<string, unknown>).type === "thinking")
    expect(thinkingStarts).toHaveLength(1)
    // The signature stays embedded on the start (the exact frame standard clients mishandle).
    expect((thinkingStarts[0].content_block as Record<string, unknown>).signature).toBe(EMBEDDED_SIG)
    // No signature_delta synthesized.
    expect(dataFramesOfType(sse, "content_block_delta").some((f) => (f.delta as Record<string, unknown>).type === "signature_delta")).toBe(false)
  })

  test("history keeps the RAW upstream frame in sseEvents while forwardedResponse reflects the compat shim", async () => {
    setStateForTests({ thinkingSignatureCompat: "signature_delta" })
    const sessionId = "thinking-sig-compat-history-test"
    await streamRequest(sessionId)

    // Query by our unique session id so this is robust to other tests' entries
    // sharing the same in-memory history runtime.
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()

    // Upstream-original sseEvents: the raw non-standard frame (signature embedded
    // on content_block_start, NO signature_delta) is preserved for diagnostics.
    const upThinkingStart = (entry.sseEvents ?? [])
      .map((e) => safeParse(e.raw))
      .find((x) => x?.type === "content_block_start" && (x.content_block as Record<string, unknown> | undefined)?.type === "thinking")
    expect(upThinkingStart).toBeDefined()
    expect((upThinkingStart!.content_block as Record<string, unknown>).signature).toBe(EMBEDDED_SIG)
    const upHasSigDelta = (entry.sseEvents ?? [])
      .map((e) => safeParse(e.raw))
      .some((x) => (x?.delta as Record<string, unknown> | undefined)?.type === "signature_delta")
    expect(upHasSigDelta).toBe(false)

    // Forwarded (proxy→client) record: the compat-shimmed frames — empty thinking
    // start + synthesized signature_delta.
    const fwd = (entry.inboundResponse?.sseEvents ?? []).map((e) => safeParse(e.raw))
    const fwdThinkingStart = fwd.find((x) => x?.type === "content_block_start" && (x.content_block as Record<string, unknown> | undefined)?.type === "thinking")
    expect((fwdThinkingStart!.content_block as Record<string, unknown>).signature).toBe("")
    const fwdSigDelta = fwd.find((x) => (x?.delta as Record<string, unknown> | undefined)?.type === "signature_delta")
    expect((fwdSigDelta!.delta as Record<string, unknown>).signature).toBe(EMBEDDED_SIG)
  })
})

/** Parse an SSE `raw` data payload to an object, or undefined when not JSON. */
function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}
