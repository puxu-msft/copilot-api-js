/**
 * C0 golden pre-capture (b) — REVERSE `@messages` forwarded frame-by-frame byte golden (HTTP app).
 *
 * A cc client (`POST /chat/completions`, `model:"<claude>@messages"`) pins the REVERSE Anthropic leg:
 *   request:  CC body → translateOut (CC→Anthropic) → prepareWire → upstream `/v1/messages` (Anthropic)
 *   response: upstream Anthropic SSE → codec.renderResponse (Anthropic→CC per-frame) → forwarded CC SSE
 *
 * WHY this is missing (RFC §0.1): the existing reverse coverage (`reverse-cc-messages.it.test.ts`) drives
 * the driver directly + asserts via `inspectRequest` (dry-run wire) + a CC accumulator oracle — there is NO
 * HTTP-app forwarded SSE byte golden of the Anthropic→CC per-frame translation. C2 migrates this reverse leg
 * onto the AnthropicCellAssembly (deletes the handler's reverse supply/betaProbe/mapperHolder + the anthropic
 * codec direct branch); this locks the exact forwarded CC bytes so that migration stays byte-identical.
 *
 * Heartbeat OFF so the forwarded byte stream is deterministic (this golden locks the TRANSLATION per-frame
 * bytes, not the anchor — that's golden (a)).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import {
  //
  setDisabledModels,
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
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
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const CLAUDE = "claude-opus-4.8"

/** An upstream Anthropic generation: text + tool_use + terminal (what the reverse leg renders back to CC). */
function anthropicUpstreamFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_rev", model, inputTokens: 20 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "Let me check. "),
    blockStopFrame(0),
    toolBlockStartFrame(1, "toolu_rev", "get_weather"),
    jsonDeltaFrame(1, '{"city":"SF"}'),
    blockStopFrame(1),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 6 }),
    MESSAGE_STOP_FRAME,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/v1/messages")) return Promise.resolve(createSseResponse(anthropicUpstreamFrames(payload.model ?? CLAUDE)))
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

function injectModels(): void {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(CLAUDE, { vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions"] })] })
}

describe("C0 golden (b) — reverse @messages forwarded CC bytes (Anthropic→CC per-frame)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok", streamKeepalivePingSec: 0, streamCommitAfterSec: 0 })
  })

  test("cc client @messages streaming → forwarded CC frames are byte-locked", async () => {
    injectModels()
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-reverse-cc" },
      body: JSON.stringify({ model: `${CLAUDE}@messages`, messages: [{ role: "user", content: "weather?" }], stream: true }),
    })
    expect(res.status).toBe(200)
    // Normalize the synthesized `created` epoch (Date.now-derived) for a stable byte-lock on the
    // Anthropic→CC per-frame translation (same normalization the direct-CC golden uses).
    const text = (await res.text()).replaceAll(/"created":\d+/g, '"created":0')

    // ── BYTE GOLDEN: the exact forwarded CC SSE the client receives on the reverse @messages leg ─────────
    // Upstream Anthropic frames (message_start → text block → tool_use block → terminal) rendered per-frame
    // back to CC chunks: role delta → content delta → tool_call open → tool_call args → finish → usage → [DONE].
    // Each frame carries `event: message`. The tool_call id is the upstream Anthropic `toolu_rev` (id passthrough).
    const chunk = (over: string): string =>
      `event: message\ndata: {"id":"msg_rev","object":"chat.completion.chunk","created":0,"model":"${CLAUDE}",${over}}\n\n`
    const usageChunk = `event: message\ndata: {"id":"msg_rev","object":"chat.completion.chunk","created":0,"model":"${CLAUDE}","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26}}\n\n`
    const golden =
      chunk('"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null,"logprobs":null}]')
      + chunk('"choices":[{"index":0,"delta":{"content":"Let me check. "},"finish_reason":null,"logprobs":null}]')
      + chunk(
        '"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_rev","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null,"logprobs":null}]',
      )
      + chunk(
        String.raw`"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":\"SF\"}"}}]},"finish_reason":null,"logprobs":null}]`,
      )
      + chunk('"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls","logprobs":null}]')
      + usageChunk
      + "data: [DONE]\n\n"
    expect(text).toBe(golden)

    // Cross-check invariants the byte golden already encodes (explicit for regression readability):
    expect(text).toContain('"content":"Let me check. "') //          the Anthropic text_delta became a CC content delta
    expect(text).toContain('"id":"toolu_rev","type":"function"') //   the tool_use id passed through to the CC tool_call
    expect(text).toContain('"finish_reason":"tool_calls"') //         stop_reason:tool_use → CC finish_reason
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true) //           CC terminates with a synthesized [DONE]

    const entry = getHistory({ endpoint: "openai-chat-completions", sessionId: "c0-reverse-cc", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })
})
