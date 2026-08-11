import Anthropic from "@anthropic-ai/sdk"
import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import OpenAI from "openai"

import { extractClaudeSignature } from "~/lib/anthropic/claude-signature-carrier"
import { extractEncryptedReasoning } from "~/lib/anthropic/synthetic-reasoning"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import {
  //
  type InProcessProxy,
  serveInProcess,
} from "../../e2e-client/harness/serve-in-process"
import {
  //
  createSseResponse,
  jsonResponse,
  type ScriptedUpstream,
} from "../../e2e-client/harness/upstream-script"
import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

const RESPONSES_MODEL = "gpt-semantic-responses"
const ANTHROPIC_MODEL = "claude-semantic-messages"
const DONE = "data: [DONE]\n\n"
const EXCLUDED_UNSTABLE_RESPONSE_HEADERS = ["content-length", "date", "transfer-encoding"] as const

/**
 * Inline digests are the non-updateable authority for the golden bytes. `bun test -u` may rewrite the
 * companion snapshots, but it cannot rewrite this table; changing a digest is allowed only with the
 * corresponding C9/C10 direction cutover, in the same reviewed commit.
 */
const CLIENT_WIRE_DIGESTS = {
  "A→R:stream": { byteLength: 794, sha256: "5b52f8233ea8ccd121d35c7de109dd21fac455c9255ea6edd3eef402b4cf3d59" },
  "A→R:stream-thinking": { byteLength: 1024, sha256: "9582982fa57234126b90bf2d293ae70493ce90edd977fdf167dee3d15ce84329" },
  "A→R:stream-tool": { byteLength: 1339, sha256: "681c00513938a97b5bdaab99fb45b5e4598f8d98456b5447b63cf60d73dfd0f0" },
  "A→R:non-stream": { byteLength: 247, sha256: "8bdedd7440b54417da169f44fad4866090ef6716a9966f27991347503904bc72" },
  "A→R:non-stream-thinking": { byteLength: 385, sha256: "f9d4c9262048ec83e1617e5ed640d60d593116fd0bdabe8d0b005a8ef039215d" },
  "A→R:non-stream-encrypted-only": { byteLength: 233, sha256: "ce4375b5d349530908efa22785890aa4cec41d08c24024d361a39cd2eebf68b2" },
  "A→R:error": { byteLength: 103, sha256: "fbe2971562750f88ad87ab29fa96223d3fca6e9abbeca1b35298186224c14462" },
  "R→A:stream": { byteLength: 1886, sha256: "cbb48cd9b8d28fce24b3e1d470349e4da7eae4a9526224d8b062ef28e21b257c" },
  "R→A:stream-reasoning": { byteLength: 2814, sha256: "60d18f9272f6188efb8ff9354d421308b03747c8f098c3deaee15bcdd67fbfb1" },
  "R→A:stream-tool": { byteLength: 1867, sha256: "85d547cd963f5c8032ef457c0d42d3db25e2be4f8acd4a6095659588f5997ed2" },
  "R→A:non-stream": { byteLength: 437, sha256: "8ed953fa69630572602fa28de693512bbaec986a87463d2da69128083d1fc30b" },
  "R→A:non-stream-reasoning": { byteLength: 669, sha256: "159822bf57e83e8914b5a76beaa916e601ee39ed150da64e0c1c04fe49c7eed7" },
  "R→A:non-stream-redacted": { byteLength: 441, sha256: "f948f17c5181da854494459857ecd6ff8d55e471e22ff3568d7d93a99f6d2462" },
  "R→A:error": { byteLength: 133, sha256: "24084e61b836ab1952c87817ea2ad6ac14c638fce917701035ea7ab12dae6a01" },
} as const

type ClientWireDigestKey = keyof typeof CLIENT_WIRE_DIGESTS

const EXPECTED_GOLDEN_CASE_KEYS = [
  "A→R:stream:no-retry",
  "A→R:stream:retry",
  "A→R:stream-thinking:no-retry",
  "A→R:stream-tool:no-retry",
  "A→R:non-stream-thinking:no-retry",
  "A→R:non-stream-encrypted-only:no-retry",
  "A→R:error:no-retry",
  "A→R:non-stream:no-retry",
  "A→R:non-stream:retry",
  "R→A:stream:no-retry",
  "R→A:stream:retry",
  "R→A:stream-reasoning:no-retry",
  "R→A:stream-tool:no-retry",
  "R→A:non-stream-reasoning:no-retry",
  "R→A:non-stream-redacted:no-retry",
  "R→A:error:no-retry",
  "R→A:non-stream:no-retry",
  "R→A:non-stream:retry",
] as const

type GoldenCaseKey = (typeof EXPECTED_GOLDEN_CASE_KEYS)[number]

interface ClientWireCapture {
  status: number
  headers: Array<readonly [string, string]>
  bodyHex: string
}

interface GoldenCoverage {
  direction: "A→R" | "R→A"
  hasThinking: boolean
  hasSignature: boolean
  hasReasoning: boolean
  hasEncrypted: boolean
}

const goldenCoverage = new Map<GoldenCaseKey, GoldenCoverage>()

function wireCoverage(direction: GoldenCoverage["direction"], capture: ClientWireCapture): GoldenCoverage {
  const wire = Buffer.from(capture.bodyHex, "hex").toString("utf8")
  return {
    direction,
    hasThinking: wire.includes('"type":"thinking"'),
    hasSignature: wire.includes('"type":"signature_delta"'),
    hasReasoning: wire.includes("response.reasoning_summary_text.delta"),
    hasEncrypted: wire.includes('"encrypted_content"'),
  }
}

function containsDirectionalReasoningMarker(direction: GoldenCoverage["direction"], capture: ClientWireCapture): boolean {
  const coverage = wireCoverage(direction, capture)
  return direction === "A→R" ? coverage.hasThinking && coverage.hasSignature : coverage.hasReasoning && coverage.hasEncrypted
}

function canonicalClientWire(capture: ClientWireCapture): Uint8Array {
  const headers = capture.headers.map(([name, value]) => `${name}:${value}`).join("\n")
  const prefix = new TextEncoder().encode(`${capture.status}\n${headers}\n\n`)
  const body = Uint8Array.fromHex(capture.bodyHex)
  const canonical = new Uint8Array(prefix.byteLength + body.byteLength)
  canonical.set(prefix)
  canonical.set(body, prefix.byteLength)
  return canonical
}

async function assertFixedClientWireDigest(caseKey: GoldenCaseKey, digestKey: ClientWireDigestKey, capture: ClientWireCapture): Promise<void> {
  const body = Uint8Array.fromHex(capture.bodyHex)
  const canonical = canonicalClientWire(capture)
  const actualHash = Buffer.from(await crypto.subtle.digest("SHA-256", canonical)).toString("hex")
  const expected = CLIENT_WIRE_DIGESTS[digestKey]
  expect(body.byteLength).toBe(expected.byteLength)
  expect(actualHash).toBe(expected.sha256)
  goldenCoverage.set(caseKey, wireCoverage(caseKey.startsWith("A→R:") ? "A→R" : "R→A", capture))
}

/**
 * Client-side capture point: the official SDK calls this fetch, which performs a real HTTP request to
 * {@link serveInProcess}; cloning the localhost Response records the exact entity bytes delivered by
 * the proxy's client sink before either SDK parses or accumulates them.
 */
function capturingClientFetch(captures: Array<ClientWireCapture>): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init)
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    const excluded = new Set<string>(EXCLUDED_UNSTABLE_RESPONSE_HEADERS)
    // Codepoint order, never localeCompare: this ordering feeds canonicalClientWire and therefore
    // decides the authority digest. localeCompare is ICU/locale sensitive — under `cs` the digraph
    // `ch` sorts after `h`, under `da` a leading `aa` sorts as `å` and lands last — so the same bytes
    // would digest differently on another machine, another Bun, or another LANG, surfacing as a
    // false-red nobody can explain.
    const headers = [...response.headers.entries()]
      .filter(([name]) => !excluded.has(name))
      .sort(([a], [b]) =>
        a < b ? -1
        : a > b ? 1
        : 0,
      )
    captures.push({ status: response.status, headers, bodyHex: Buffer.from(bytes).toString("hex") })
    return response
  }
}

function responsesJson(): Response {
  return jsonResponse({
    id: "resp_upstream_golden",
    object: "response",
    created_at: 1,
    status: "completed",
    model: RESPONSES_MODEL,
    output: [
      {
        id: "msg_output_golden",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "responses says hello", annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  })
}

function responsesReasoningStream(): Response {
  const frame = (type: string, sequenceNumber: number, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`
  const reasoningOpen = { id: "reasoning_golden", type: "reasoning", summary: [] }
  const reasoningDone = {
    id: "reasoning_golden",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "responses reasoning summary" }],
    encrypted_content: "responses-encrypted-golden",
  }
  return createSseResponse([
    frame("response.created", 0, {
      response: { id: "resp_reasoning_golden", object: "response", created_at: 1, status: "in_progress", model: RESPONSES_MODEL, output: [] },
    }),
    frame("response.output_item.added", 1, { output_index: 0, item: reasoningOpen }),
    frame("response.reasoning_summary_text.delta", 2, { item_id: "reasoning_golden", output_index: 0, summary_index: 0, delta: "responses reasoning summary" }),
    frame("response.output_item.done", 3, { output_index: 0, item: reasoningDone }),
    frame("response.completed", 4, {
      response: {
        id: "resp_reasoning_golden",
        object: "response",
        created_at: 1,
        status: "completed",
        model: RESPONSES_MODEL,
        output: [reasoningDone],
        usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    }),
    DONE,
  ])
}

function responsesToolStream(): Response {
  const frame = (type: string, sequenceNumber: number, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`
  const callOpen = { id: "fc_tool_golden", type: "function_call", call_id: "call_tool_golden", name: "lookup", arguments: "", status: "in_progress" }
  const callDone = { ...callOpen, arguments: '{"q":42}', status: "completed" }
  return createSseResponse([
    frame("response.created", 0, {
      response: { id: "resp_tool_golden", object: "response", created_at: 1, status: "in_progress", model: RESPONSES_MODEL, output: [] },
    }),
    frame("response.output_item.done", 1, {
      output_index: 0,
      item: { type: "web_search_call", id: "ws_tool_golden", status: "completed", action: { type: "search", query: "golden query" } },
    }),
    frame("response.output_item.added", 2, { output_index: 1, item: callOpen }),
    frame("response.function_call_arguments.delta", 3, { item_id: "fc_tool_golden", output_index: 1, delta: '{"q":' }),
    frame("response.function_call_arguments.delta", 4, { item_id: "fc_tool_golden", output_index: 1, delta: "42}" }),
    frame("response.function_call_arguments.done", 5, { item_id: "fc_tool_golden", output_index: 1, arguments: '{"q":42}' }),
    frame("response.output_item.done", 6, { output_index: 1, item: callDone }),
    frame("response.completed", 7, {
      response: {
        id: "resp_tool_golden",
        object: "response",
        created_at: 1,
        status: "completed",
        model: RESPONSES_MODEL,
        output: [{ type: "web_search_call", id: "ws_tool_golden", status: "completed", action: { type: "search", query: "golden query" } }, callDone],
        usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    }),
    DONE,
  ])
}

function responsesReasoningJson(): Response {
  return jsonResponse({
    id: "resp_reasoning_json_golden",
    object: "response",
    created_at: 1,
    status: "completed",
    model: RESPONSES_MODEL,
    output: [
      {
        id: "reasoning_json_golden",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "responses nonstream reasoning" }],
        encrypted_content: "responses-nonstream-encrypted",
      },
    ],
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  })
}

function responsesEncryptedOnlyJson(): Response {
  return jsonResponse({
    id: "resp_encrypted_only_golden",
    object: "response",
    created_at: 1,
    status: "completed",
    model: RESPONSES_MODEL,
    output: [{ id: "reasoning_encrypted_only_golden", type: "reasoning", summary: [], encrypted_content: "responses-encrypted-only" }],
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  })
}

function responsesStream(): Response {
  const frame = (type: string, sequenceNumber: number, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`
  const itemOpen = { id: "msg_output_golden", type: "message", role: "assistant", status: "in_progress", content: [] }
  const itemDone = {
    id: "msg_output_golden",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "responses streamed hello", annotations: [] }],
  }
  return createSseResponse([
    frame("response.created", 0, {
      response: { id: "resp_upstream_golden", object: "response", created_at: 1, status: "in_progress", model: RESPONSES_MODEL, output: [] },
    }),
    frame("response.output_item.added", 1, { output_index: 0, item: itemOpen }),
    frame("response.output_text.delta", 2, { item_id: "msg_output_golden", output_index: 0, content_index: 0, delta: "responses streamed hello" }),
    frame("response.output_item.done", 3, { output_index: 0, item: itemDone }),
    frame("response.completed", 4, {
      response: {
        id: "resp_upstream_golden",
        object: "response",
        created_at: 1,
        status: "completed",
        model: RESPONSES_MODEL,
        output: [itemDone],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    }),
    DONE,
  ])
}

function anthropicJson(): Response {
  return jsonResponse({
    id: "msg_upstream_golden",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_MODEL,
    content: [{ type: "text", text: "anthropic says hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 3 },
  })
}

function anthropicStream(): Response {
  const frame = (type: string, payload: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  return createSseResponse([
    frame("message_start", {
      message: {
        id: "msg_upstream_golden",
        type: "message",
        role: "assistant",
        model: ANTHROPIC_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "anthropic streamed hello" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    frame("message_stop", {}),
    DONE,
  ])
}

function anthropicToolStream(): Response {
  const frame = (type: string, payload: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  return createSseResponse([
    frame("message_start", {
      message: {
        id: "msg_tool_golden",
        type: "message",
        role: "assistant",
        model: ANTHROPIC_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 6, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_golden", name: "lookup", input: {} } }),
    frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } }),
    frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "42}" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } }),
    frame("message_stop", {}),
    DONE,
  ])
}

function anthropicReasoningJson(): Response {
  return jsonResponse({
    id: "msg_reasoning_json_golden",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_MODEL,
    content: [
      { type: "thinking", thinking: "anthropic nonstream reasoning", signature: "anthropic-nonstream-signature" },
      { type: "text", text: "reasoned nonstream answer" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 5 },
  })
}

function anthropicRedactedJson(): Response {
  return jsonResponse({
    id: "msg_redacted_golden",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_MODEL,
    content: [
      { type: "redacted_thinking", data: "redacted-wire-golden" },
      { type: "text", text: "visible after redaction" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 5 },
  })
}

function anthropicReasoningStream(): Response {
  const frame = (type: string, payload: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  return createSseResponse([
    frame("message_start", {
      message: {
        id: "msg_reasoning_golden",
        type: "message",
        role: "assistant",
        model: ANTHROPIC_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning summary golden" } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "opaque-reasoning-golden" } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "reasoned answer" } }),
    frame("content_block_stop", { index: 1 }),
    frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
    frame("message_stop", {}),
    DONE,
  ])
}

function errorResponse(direction: "A→R" | "R→A"): Response {
  const retryAfter = direction === "A→R" ? 11 : 13
  const headers = new Headers({ "content-type": "application/json", "x-semantic-golden": direction === "A→R" ? "a-to-r" : "r-to-a" })
  return new Response(JSON.stringify({ error: { message: `Upstream provider rate limited (${direction})`, retry_after: retryAfter } }), {
    status: 503,
    headers,
  })
}

function upstreamWithOptionalRetry(makeResponse: () => Response, retry: boolean): ScriptedUpstream {
  let calls = 0
  const bodies: Array<unknown> = []
  return {
    handler: (_url, init) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined)
      calls++
      if (retry && calls === 1) return Promise.reject(new Error("ECONNRESET: semantic bridge golden retry"))
      return Promise.resolve(makeResponse())
    },
    callCount: () => calls,
    requestBodies: () => bodies,
  }
}

describe("semantic bridge C0.2 — client wire byte golden", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  let anthropicClient: Anthropic
  let responsesClient: OpenAI
  let captures: Array<ClientWireCapture>
  let dateNowSpy: ReturnType<typeof spyOn>
  let randomUuidSpy: ReturnType<typeof spyOn>

  beforeAll(() => {
    proxy = serveInProcess()
    captures = []
    anthropicClient = new Anthropic({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0, fetch: capturingClientFetch(captures) })
    responsesClient = new OpenAI({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0, fetch: capturingClientFetch(captures) })
  })

  beforeEach(() => {
    captures.length = 0
    dateNowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    let uuidCounter = 0
    randomUuidSpy = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`)
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 0,
      upstreamWebSocket: false,
      protectStreamingGeneration: false,
      errorShapingEnabled: true,
    })
    setModels({
      object: "list",
      data: [
        mockModel(RESPONSES_MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] }),
        mockModel(ANTHROPIC_MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/responses"] }),
      ],
    })
  })

  afterEach(() => {
    dateNowSpy.mockRestore()
    randomUuidSpy.mockRestore()
    setUpstreamFetchForTests(undefined)
  })

  afterAll(() => proxy.close())

  async function captureAnthropicClientErrorWire(): Promise<ClientWireCapture> {
    setUpstreamFetchForTests(upstreamWithOptionalRetry(() => errorResponse("A→R"), false).handler)
    await anthropicClient.messages.create({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }).then(
      () => undefined,
      () => undefined,
    )
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("A→R:error:no-retry", "A→R:error", capture)
    return capture
  }

  async function captureResponsesClientErrorWire(): Promise<ClientWireCapture> {
    setUpstreamFetchForTests(upstreamWithOptionalRetry(() => errorResponse("R→A"), false).handler)
    await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: false }).then(
      () => undefined,
      () => undefined,
    )
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("R→A:error:no-retry", "R→A:error", capture)
    return capture
  }

  async function captureAnthropicClientToolWire(): Promise<ClientWireCapture> {
    const upstream = upstreamWithOptionalRetry(responsesToolStream, false)
    setUpstreamFetchForTests(upstream.handler)
    const message = await anthropicClient.messages
      .stream({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })
      .finalMessage()
    expect(message.content.find((block) => block.type === "tool_use")).toMatchObject({ type: "tool_use", name: "lookup", input: { q: 42 } })
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("A→R:stream-tool:no-retry", "A→R:stream-tool", capture)
    return capture
  }

  async function captureResponsesClientToolWire(): Promise<ClientWireCapture> {
    const upstream = upstreamWithOptionalRetry(anthropicToolStream, false)
    setUpstreamFetchForTests(upstream.handler)
    const stream = await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: true })
    let argumentDelta = ""
    for await (const event of stream) if (event.type === "response.function_call_arguments.delta") argumentDelta += event.delta
    expect(argumentDelta).toBe('{"q":42}')
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("R→A:stream-tool:no-retry", "R→A:stream-tool", capture)
    return capture
  }

  async function captureAnthropicClientNonStreamThinkingWire(): Promise<ClientWireCapture> {
    setUpstreamFetchForTests(upstreamWithOptionalRetry(responsesReasoningJson, false).handler)
    const message = await anthropicClient.messages.create({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })
    expect(message.content.find((block) => block.type === "thinking")).toMatchObject({ type: "thinking", thinking: "responses nonstream reasoning" })
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("A→R:non-stream-thinking:no-retry", "A→R:non-stream-thinking", capture)
    return capture
  }

  async function captureResponsesClientNonStreamReasoningWire(): Promise<ClientWireCapture> {
    setUpstreamFetchForTests(upstreamWithOptionalRetry(anthropicReasoningJson, false).handler)
    const response = await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: false })
    expect(response.output.find((item) => item.type === "reasoning")).toBeDefined()
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("R→A:non-stream-reasoning:no-retry", "R→A:non-stream-reasoning", capture)
    return capture
  }

  async function captureAnthropicClientEncryptedOnlyWire(): Promise<ClientWireCapture> {
    setUpstreamFetchForTests(upstreamWithOptionalRetry(responsesEncryptedOnlyJson, false).handler)
    const message = await anthropicClient.messages.create({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })
    // KNOWN-LOSS: encrypted-only reasoning is dropped by the legacy non-stream translator.
    expect(message.content).toEqual([{ type: "text", text: "" }] as never)
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("A→R:non-stream-encrypted-only:no-retry", "A→R:non-stream-encrypted-only", capture)
    return capture
  }

  async function captureResponsesClientRedactedWire(): Promise<ClientWireCapture> {
    setUpstreamFetchForTests(upstreamWithOptionalRetry(anthropicRedactedJson, false).handler)
    const response = await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: false })
    // KNOWN-LOSS: redacted_thinking has no Responses projection in the legacy non-stream translator.
    expect(JSON.stringify(response.output)).not.toContain("redacted-wire-golden")
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("R→A:non-stream-redacted:no-retry", "R→A:non-stream-redacted", capture)
    return capture
  }

  async function captureAnthropicClientThinkingWire(): Promise<ClientWireCapture> {
    const upstream = upstreamWithOptionalRetry(responsesReasoningStream, false)
    setUpstreamFetchForTests(upstream.handler)
    const message = await anthropicClient.messages
      .stream({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })
      .finalMessage()
    const thinking = message.content.find((block) => block.type === "thinking")
    expect(thinking).toMatchObject({ type: "thinking", thinking: "responses reasoning summary" })
    expect(thinking && "signature" in thinking ? extractEncryptedReasoning(thinking.signature) : undefined).toBe("responses-encrypted-golden")
    expect(upstream.callCount()).toBe(1)
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("A→R:stream-thinking:no-retry", "A→R:stream-thinking", capture)
    return capture
  }

  async function captureAnthropicClientWire(args: { stream: boolean; retry: boolean }): Promise<ClientWireCapture> {
    const upstream = upstreamWithOptionalRetry(args.stream ? responsesStream : responsesJson, args.retry)
    setUpstreamFetchForTests(upstream.handler)
    if (args.stream) {
      await anthropicClient.messages.stream({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }).finalMessage()
    } else {
      await anthropicClient.messages.create({ model: RESPONSES_MODEL, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })
    }
    expect(upstream.callCount()).toBe(args.retry ? 2 : 1)
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    const shape = args.stream ? "stream" : "non-stream"
    const retry = args.retry ? "retry" : "no-retry"
    await assertFixedClientWireDigest(`A→R:${shape}:${retry}`, args.stream ? "A→R:stream" : "A→R:non-stream", capture)
    return capture
  }

  async function captureResponsesClientReasoningWire(): Promise<ClientWireCapture> {
    const upstream = upstreamWithOptionalRetry(anthropicReasoningStream, false)
    setUpstreamFetchForTests(upstream.handler)
    const stream = await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: true })
    let summary = ""
    let encryptedContent: string | undefined
    for await (const event of stream) {
      if (event.type === "response.reasoning_summary_text.delta") summary += event.delta
      if (event.type === "response.output_item.done" && event.item.type === "reasoning") encryptedContent = event.item.encrypted_content ?? undefined
    }
    expect(summary).toBe("reasoning summary golden")
    expect(extractClaudeSignature(encryptedContent)).toBe("opaque-reasoning-golden")
    expect(upstream.callCount()).toBe(1)
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    await assertFixedClientWireDigest("R→A:stream-reasoning:no-retry", "R→A:stream-reasoning", capture)
    return capture
  }

  async function captureResponsesClientWire(args: { stream: boolean; retry: boolean }): Promise<ClientWireCapture> {
    const upstream = upstreamWithOptionalRetry(args.stream ? anthropicStream : anthropicJson, args.retry)
    setUpstreamFetchForTests(upstream.handler)
    if (args.stream) {
      const stream = await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: true })
      for await (const _event of stream) void _event
    } else {
      await responsesClient.responses.create({ model: `${ANTHROPIC_MODEL}@messages`, input: "hello", stream: false })
    }
    expect(upstream.callCount()).toBe(args.retry ? 2 : 1)
    expect(captures).toHaveLength(1)
    const capture = captures[0]
    const shape = args.stream ? "stream" : "non-stream"
    const retry = args.retry ? "retry" : "no-retry"
    await assertFixedClientWireDigest(`R→A:${shape}:${retry}`, args.stream ? "R→A:stream" : "R→A:non-stream", capture)
    return capture
  }

  test("A→R client wire：stream，no retry", async () => {
    expect(await captureAnthropicClientWire({ stream: true, retry: false })).toMatchSnapshot()
  })

  test("A→R client wire：stream，retry", async () => {
    expect(await captureAnthropicClientWire({ stream: true, retry: true })).toMatchSnapshot()
  })

  test("A→R client wire：stream thinking summary + signature，no retry（锁定当前正常 reasoning→thinking 行为）", async () => {
    expect(await captureAnthropicClientThinkingWire()).toMatchSnapshot()
  })

  test("A→R client wire：stream tool_use + input_json_delta，no retry", async () => {
    expect(await captureAnthropicClientToolWire()).toMatchSnapshot()
  })

  test("A→R client wire：non-stream thinking + signature，no retry", async () => {
    expect(await captureAnthropicClientNonStreamThinkingWire()).toMatchSnapshot()
  })

  test("A→R client wire：non-stream encrypted-only reasoning（锁定当前丢失缺陷）", async () => {
    expect(await captureAnthropicClientEncryptedOnlyWire()).toMatchSnapshot()
  })

  test("A→R client wire：HTTP 503 error body + retry headers（锁定当前错误腿现状）", async () => {
    expect(await captureAnthropicClientErrorWire()).toMatchSnapshot()
  })

  test("A→R client wire：non-stream，no retry", async () => {
    expect(await captureAnthropicClientWire({ stream: false, retry: false })).toMatchSnapshot()
  })

  test("A→R client wire：non-stream，retry", async () => {
    expect(await captureAnthropicClientWire({ stream: false, retry: true })).toMatchSnapshot()
  })

  test("R→A client wire：stream，no retry", async () => {
    expect(await captureResponsesClientWire({ stream: true, retry: false })).toMatchSnapshot()
  })

  test("R→A client wire：stream，retry", async () => {
    expect(await captureResponsesClientWire({ stream: true, retry: true })).toMatchSnapshot()
  })

  test("R→A client wire：stream reasoning summary + encrypted content，no retry", async () => {
    expect(await captureResponsesClientReasoningWire()).toMatchSnapshot()
  })

  test("R→A client wire：stream function_call + arguments delta，no retry", async () => {
    expect(await captureResponsesClientToolWire()).toMatchSnapshot()
  })

  test("R→A client wire：non-stream reasoning + encrypted content，no retry", async () => {
    expect(await captureResponsesClientNonStreamReasoningWire()).toMatchSnapshot()
  })

  test("R→A client wire：non-stream redacted_thinking（锁定当前丢失缺陷）", async () => {
    expect(await captureResponsesClientRedactedWire()).toMatchSnapshot()
  })

  test("R→A client wire：HTTP 503 error body + retry headers（锁定当前错误腿现状）", async () => {
    expect(await captureResponsesClientErrorWire()).toMatchSnapshot()
  })

  test("R→A client wire：non-stream，no retry", async () => {
    expect(await captureResponsesClientWire({ stream: false, retry: false })).toMatchSnapshot()
  })

  test("R→A client wire：non-stream，retry", async () => {
    expect(await captureResponsesClientWire({ stream: false, retry: true })).toMatchSnapshot()
  })

  test("coverage guard：已执行 golden 用例键与冻结的 18 元集合精确相等，并覆盖双向 reasoning", () => {
    const actual = [...goldenCoverage.keys()].sort()
    const expected = [...EXPECTED_GOLDEN_CASE_KEYS].sort()
    expect(actual, "本用例必须与整个文件一起跑；单独 -t 会因登记表不完整而红").toEqual(expected)
    expect(expected.filter((key) => !goldenCoverage.has(key))).toEqual([])
    expect(actual.filter((key) => !EXPECTED_GOLDEN_CASE_KEYS.includes(key))).toEqual([])
    const entries = [...goldenCoverage.values()]
    expect(entries.some((entry) => entry.direction === "A→R" && entry.hasThinking && entry.hasSignature)).toBe(true)
    expect(entries.some((entry) => entry.direction === "R→A" && entry.hasReasoning && entry.hasEncrypted)).toBe(true)
  })

  test("coverage guard negative control：纯 text wire 不能冒充任一方向的 thinking／reasoning 覆盖", async () => {
    const anthropicTextWire = await captureAnthropicClientWire({ stream: true, retry: false })
    captures.length = 0
    const responsesTextWire = await captureResponsesClientWire({ stream: true, retry: false })
    expect(containsDirectionalReasoningMarker("A→R", anthropicTextWire)).toBe(false)
    expect(containsDirectionalReasoningMarker("R→A", responsesTextWire)).toBe(false)
  })
})
