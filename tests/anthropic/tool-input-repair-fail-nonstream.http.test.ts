/**
 * P5 — non-streaming parallel of the unrepairable malformed tool-input fail channel.
 *
 * A non-streaming Anthropic response whose `tool_use.input` arrived as an unparsed,
 * unrepairable string is recorded FAILED (the body is still forwarded — richest-
 * data-flow), mirroring the streaming gate. A repairable string is rewritten to a
 * structured object on the forwarded body and the request still succeeds.
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

const MODEL = "claude-opus-4.8"

const UNREPAIRABLE_INPUT = '{"a":1,,,}'
const REPAIRABLE_INPUT = '{"todos":[{"content":"x","status":"pending","activeForm":"y"}]</parameter></invoke>}'

let toolInput: unknown = UNREPAIRABLE_INPUT

function anthropicBody(model: string): Record<string, unknown> {
  return {
    id: "msg_ns",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "tool_use", id: "toolu_ns", name: "TodoWrite", input: toolInput }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8 },
  }
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/v1/messages")) {
    return new Response(JSON.stringify(anthropicBody(payload.model ?? MODEL)), { status: 200, headers: { "content-type": "application/json" } })
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function nonStreamRequest(sessionId: string): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: false }),
  })
}

function configure(repair: "tags" | "repair" | false): void {
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    fetchTimeout: 0,
    toolRepairMalformedInput: repair,
  })
  applyFetchMock(upstreamFetchMock)
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
}

describe("POST /v1/messages (non-streaming) — unrepairable malformed tool-input fail (P5)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    toolInput = UNREPAIRABLE_INPUT
  })

  test("repair mode: unrepairable string input → history FAILED, partial preserved", async () => {
    configure("repair")
    toolInput = UNREPAIRABLE_INPUT
    const sessionId = "ns-unrep"
    const res = await nonStreamRequest(sessionId)
    expect(res.status).toBe(200) // body still forwarded

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("failed")
    expect(entry.outboundResponse?.success).toBe(false)
    expect(entry.outboundResponse?.content).not.toBeNull()
  })

  test("repair mode: a repairable antml-bleed string input → SUCCEEDS with a structured object on the wire", async () => {
    configure("repair")
    toolInput = REPAIRABLE_INPUT
    const sessionId = "ns-repairable"
    const res = await nonStreamRequest(sessionId)
    const body = (await res.json()) as { content: Array<{ type: string; input: unknown }> }
    // The forwarded body carries the repaired, structured input (not the malformed string).
    const toolBlock = body.content.find((b) => b.type === "tool_use")
    expect(typeof toolBlock?.input).toBe("object")
    expect((toolBlock?.input as { todos: Array<unknown> }).todos).toHaveLength(1)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("completed")
  })

  test("repair off (default): unrepairable string input is forwarded as-is, request completes", async () => {
    configure(false)
    toolInput = UNREPAIRABLE_INPUT
    const sessionId = "ns-off"
    await nonStreamRequest(sessionId)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("completed")
  })
})
