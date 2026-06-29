/**
 * End-to-end forwarding of upstream (GHC) response headers to the client on /v1/messages,
 * gated by `anthropic.strict_response_headers` (lib/anthropic/response-header-forward.ts).
 *
 * The proxy is otherwise fully isolating. These tests assert the two NON-committed write-out
 * paths actually forward (non-streaming + streaming settled within the commit window), that the
 * strict allowlist vs permissive blacklist behave per mode, that proxy-controlled framing headers
 * (content-length / content-type) are NEVER forwarded, and that a delayed-commit stream (commit
 * window = 0) forwards nothing (the documented limitation).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

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
  applyFetchMock,
} from "../helpers/mock-fetch"

const MODEL = "claude-opus-4.8"

/** The upstream response headers used by every test — a mix of allowlisted, arbitrary, and proxy-controlled. */
const UPSTREAM_HEADERS: Record<string, string> = {
  "request-id": "req_upstream_abc",
  "anthropic-ratelimit-requests-remaining": "42",
  "anthropic-organization-id": "org_xyz",
  "x-internal-foo": "should-only-survive-in-permissive",
  // proxy-controlled — must NEVER reach the client (would corrupt framing).
  "content-length": "999999",
  "content-type": "application/json",
}

function nonStreamBody(): string {
  return JSON.stringify({
    id: "msg_x",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 4 },
  })
}

function streamFrames(): Array<string> {
  return [
    messageStartFrame({ id: "msg_stream", model: MODEL }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "hi"),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "end_turn", outputTokens: 5 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

let streamMode = false

const upstreamFetchMock = mock(async (input: string | URL | Request) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
  if (streamMode) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of streamFrames()) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { ...UPSTREAM_HEADERS, "content-type": "text/event-stream" } })
  }
  return new Response(nonStreamBody(), { status: 200, headers: UPSTREAM_HEADERS })
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

function messagesRequest(stream: boolean): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": `hdr-fwd-${stream ? "stream" : "json"}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream }),
  })
}

describe("POST /v1/messages — upstream response-header forwarding", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    streamMode = false
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  describe("non-streaming", () => {
    test("permissive (default false): forwards everything except the proxy-controlled blacklist", async () => {
      setStateForTests({ strictResponseHeaders: false })
      const res = await messagesRequest(false)
      await res.text()

      expect(res.headers.get("request-id")).toBe("req_upstream_abc")
      expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("42")
      expect(res.headers.get("anthropic-organization-id")).toBe("org_xyz")
      expect(res.headers.get("x-internal-foo")).toBe("should-only-survive-in-permissive")
      // Proxy-controlled: upstream content-length never forwarded; content-type is the proxy's own.
      expect(res.headers.get("content-length")).not.toBe("999999")
      expect(res.headers.get("content-type")).toContain("application/json")
    })

    test("strict (true): forwards only the allowlist, drops arbitrary upstream fields", async () => {
      setStateForTests({ strictResponseHeaders: true })
      const res = await messagesRequest(false)
      await res.text()

      expect(res.headers.get("request-id")).toBe("req_upstream_abc")
      expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("42")
      expect(res.headers.get("anthropic-organization-id")).toBe("org_xyz")
      expect(res.headers.get("x-internal-foo")).toBeNull()
      expect(res.headers.get("content-length")).not.toBe("999999")
    })
  })

  describe("streaming settled within the commit window", () => {
    test("permissive: forwards onto the SSE response", async () => {
      setStateForTests({ strictResponseHeaders: false, streamCommitAfterSec: 30 })
      streamMode = true
      const res = await messagesRequest(true)
      const body = await res.text()
      expect(body).toContain("message_stop") // upstream settled → real SSE forwarded

      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(res.headers.get("request-id")).toBe("req_upstream_abc")
      expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("42")
      expect(res.headers.get("x-internal-foo")).toBe("should-only-survive-in-permissive")
    })

    test("strict: forwards only the allowlist onto the SSE response", async () => {
      setStateForTests({ strictResponseHeaders: true, streamCommitAfterSec: 30 })
      streamMode = true
      const res = await messagesRequest(true)
      await res.text()

      expect(res.headers.get("request-id")).toBe("req_upstream_abc")
      expect(res.headers.get("x-internal-foo")).toBeNull()
    })
  })

  describe("delayed-commit limitation", () => {
    test("commit window 0 → 200 flushed before upstream settles → NOTHING forwarded", async () => {
      // streamCommitAfterSec=0 forces an immediate 200 commit; upstream headers arrive after the
      // response headers are already on the wire, so the forwarding path is structurally unreachable.
      setStateForTests({ strictResponseHeaders: false, streamCommitAfterSec: 0 })
      streamMode = true
      const res = await messagesRequest(true)
      await res.text()

      expect(res.headers.get("request-id")).toBeNull()
      expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBeNull()
      expect(res.headers.get("x-internal-foo")).toBeNull()
    })
  })
})
