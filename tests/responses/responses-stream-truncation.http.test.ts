/**
 * Upstream stream truncation detection — Responses path (direct).
 *
 * A complete Responses stream always carries a terminal `response.completed` /
 * `.incomplete` / `.failed`. When the upstream sends content then cleanly closes
 * WITHOUT any terminal, the proxy must settle FAILED and emit a Responses error frame.
 *
 * See docs/rfc/upstream-stream-truncation-detection.md.
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
  setDisabledModels,
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

const MODEL = "gpt-5"

// Truncated: created + a text delta, then EOF. NO response.completed/incomplete/failed.
function responsesTruncatedFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_up_1", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, delta: "Hi" })}\n\n`,
    // EOF — no terminal response event.
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/responses")) return Promise.resolve(createSseResponse(responsesTruncatedFrames(payload.model ?? MODEL)))
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function post(): Promise<Response> {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  return app.request("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "hi", stream: true }),
  })
}

describe("Responses v4 — upstream stream truncation detection", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      streamIdleTimeout: 0,
      upstreamWebSocket: false,
    })
    applyFetchMock(upstreamFetchMock)
  })

  test("truncated Responses stream → error frame to client, history FAILED", async () => {
    const sse = await (await post()).text()

    // A clean terminator: a Responses error frame.
    expect(sse).toContain('"error"')
    expect(sse).toContain("truncated")

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("failed")
    expect(entry.outboundResponse?.success).toBe(false)
    expect(String(entry.outboundResponse?.error)).toContain("truncated")
    // The synthesized error frame the client received is recorded in the forwarded (proxy→client)
    // track — asserts the writeSynthetic→recordForwarded→fail ordering on the Responses path.
    expect((entry.inboundResponse?.sseEvents ?? []).some((e) => e.raw.includes('"error"'))).toBe(true)
  })
})
