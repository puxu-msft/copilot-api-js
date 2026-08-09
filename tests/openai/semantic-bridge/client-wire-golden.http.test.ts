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

/**
 * Inline digests are the non-updateable authority for the golden bytes. `bun test -u` may rewrite the
 * companion snapshots, but it cannot rewrite this table; changing a digest is allowed only with the
 * corresponding C9/C10 direction cutover, in the same reviewed commit.
 */
const CLIENT_WIRE_DIGESTS = {
  "A→R:stream": { byteLength: 794, sha256: "3ca27db7a9680c73ede46e67ffcb69ca085674e3bc39f7037af9ca73268a6b1f" },
  "A→R:stream-thinking": { byteLength: 1024, sha256: "b9401bb11a1dcc8d5d7a94b27276ce7b523a0653e5cd6854f49bee995741879e" },
  "A→R:non-stream": { byteLength: 247, sha256: "07b986d706be6cf8dd404603cde0ece76cce0543b2e87649077d5e3d13fc34a7" },
  "R→A:stream": { byteLength: 1886, sha256: "a023fc92b9cd847ef525656fb0765bee28b14ef0a1798a4516cde2b3f8299b49" },
  "R→A:stream-reasoning": { byteLength: 2814, sha256: "c039bd10a4112dd666e7d80370ff6c987fb9e23c1fa29178fb946faaa615a5ab" },
  "R→A:non-stream": { byteLength: 437, sha256: "0febc268933ff3e964d27990ba7cfd77d1c3e510b4f2818d56cac2df7c53eabe" },
} as const

type ClientWireDigestKey = keyof typeof CLIENT_WIRE_DIGESTS

interface ClientWireCapture {
  status: number
  contentType: string | null
  bodyHex: string
}

interface GoldenCoverage {
  direction: "A→R" | "R→A"
  hasThinking: boolean
  hasSignature: boolean
  hasReasoning: boolean
  hasEncrypted: boolean
}

const goldenCoverage = new Map<ClientWireDigestKey, GoldenCoverage>()

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

async function assertFixedClientWireDigest(key: ClientWireDigestKey, capture: ClientWireCapture): Promise<void> {
  const bytes = Uint8Array.fromHex(capture.bodyHex)
  const actualHash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")
  const expected = CLIENT_WIRE_DIGESTS[key]
  expect(bytes.byteLength).toBe(expected.byteLength)
  expect(actualHash).toBe(expected.sha256)
  goldenCoverage.set(key, wireCoverage(key.startsWith("A→R:") ? "A→R" : "R→A", capture))
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
    captures.push({
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodyHex: Buffer.from(bytes).toString("hex"),
    })
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
    await assertFixedClientWireDigest("A→R:stream-thinking", capture)
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
    await assertFixedClientWireDigest(args.stream ? "A→R:stream" : "A→R:non-stream", capture)
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
    await assertFixedClientWireDigest("R→A:stream-reasoning", capture)
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
    await assertFixedClientWireDigest(args.stream ? "R→A:stream" : "R→A:non-stream", capture)
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

  test("R→A client wire：non-stream，no retry", async () => {
    expect(await captureResponsesClientWire({ stream: false, retry: false })).toMatchSnapshot()
  })

  test("R→A client wire：non-stream，retry", async () => {
    expect(await captureResponsesClientWire({ stream: false, retry: true })).toMatchSnapshot()
  })

  test("coverage guard：已执行 golden 集合中 A→R 与 R→A 各有方向对应的 thinking／reasoning marker", () => {
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
