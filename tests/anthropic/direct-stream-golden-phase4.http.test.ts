/**
 * Phase 4 T4.0 — direct-Anthropic streaming byte golden (pre-change lock).
 *
 * The single hard evidence of the Phase 4 byte-critical invariant: the DIRECT
 * `/v1/messages` streaming path (targetEndpoint === /v1/messages, translate/render
 * are identity) forwards the upstream Anthropic SSE frames verbatim, terminating at
 * `[DONE]`. Captured BEFORE any Phase 4 code lands (cc-to-anthropic-stream translator,
 * the codec's per-leg renderResponse/createResponseAccumulator, the handler's per-leg
 * upstream accumulator dispatch) — every Phase 4 commit MUST keep this byte-for-byte.
 *
 * Distinct from the existing streaming goldens (anthropic-v4.http.test.ts locks the
 * text-only + thinking passthrough; response-rewrite-golden.http.test.ts locks the
 * ACTIVATED rewrite chains; streaming-l2-baseline.http.test.ts locks complete + RST):
 * this locks a MIXED thinking → text → tool_use → terminal stream in one shot — the exact
 * frame classes the forward translator (T4.1) must NOT perturb on the direct leg, plus
 * the `assertEventLineInvariant` scan (N1: every synthesized frame carries an `event:`
 * line the @anthropic-ai/sdk decoder dispatches on, else it silently drops the frame).
 *
 * Heartbeat OFF (`streamKeepalivePingSec=0`) + immediate commit (`streamCommitAfterSec=0`)
 * so no synthetic ping / anchor is ever interleaved — the forwarded byte stream is
 * deterministic (ping timing is covered by fake-sse-heartbeat / keepalive-e2e).
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
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

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
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "claude-opus-4.8"

/** The set of Anthropic stream event names the @anthropic-ai/sdk SSEDecoder dispatches on. */
const SDK_STREAM_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
  "error",
])

/**
 * N1 invariant: every forwarded Anthropic SSE frame carrying a JSON `type` MUST also
 * carry a recognized `event:` line — the SDK decoder dispatches on the event NAME and
 * silently DROPS an event-less / unknown frame. Locks the class so no Phase 4 change can
 * emit an event-less (dropped) frame on the direct leg.
 */
function assertEventLineInvariant(wire: string): void {
  for (const blk of wire.split("\n\n")) {
    if (!blk.trim()) continue
    const lines = blk.split("\n")
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6)
    if (!data || data === "[DONE]") continue
    if ((JSON.parse(data) as { type?: string }).type === undefined) continue
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7)
    expect(SDK_STREAM_EVENTS.has(event ?? ""), `frame ${data.slice(0, 60)} must carry a recognized "event:" line`).toBe(true)
  }
}

/** A mixed generation: thinking (with signature) → text → tool_use → terminal. */
function mixedStreamFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_p4t0", model, inputTokens: 42 }),
    // thinking block first (W2 thinking-first order on the wire — identity on direct)
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning about it" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-p4-xyz" } })}\n\n`,
    blockStopFrame(0),
    // text block
    textBlockStartFrame(1),
    textDeltaFrame(1, "Writing the file now."),
    blockStopFrame(1),
    // tool_use block
    toolBlockStartFrame(2, "toolu_p4t0", "Write"),
    jsonDeltaFrame(2, '{"file_path": "/tmp/p4.md", "content": "# hi"}'),
    blockStopFrame(2),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 31 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL
  if (url.endsWith("/v1/messages")) return Promise.resolve(createSseResponse(mixedStreamFrames(model)))
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(sessionId: string): Promise<string> {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "write a file" }], max_tokens: 256, stream: true }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  return res.text()
}

describe("Phase 4 T4.0 — direct-Anthropic streaming byte golden (pre-change lock)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 0,
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("mixed thinking → text → tool_use stream forwarded byte-for-byte (identity), event-line invariant, history completed", async () => {
    const sse = await streamRequest("p4t0-direct")

    // Byte golden: the direct leg forwards every upstream frame verbatim, dropping only
    // the trailing `data: [DONE]` (the pump breaks before it — Anthropic emits no terminator).
    const expected = mixedStreamFrames(MODEL).slice(0, -1).join("")
    expect(sse).toBe(expected)

    // N1: every forwarded frame carries a recognized event: line (SDK-survivable).
    assertEventLineInvariant(sse)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "p4t0-direct", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
  })
})
