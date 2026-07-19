/**
 * Task 5.5 — `@ai-sdk/openai` delta-sensitive consumer accepts the drop-delta merged wire.
 *
 * Complements responses-nodelta.probe.it.test.ts (which uses the OFFICIAL `openai` SDK, whose stream
 * THROWS on a landmine). `@ai-sdk/openai` streams errors as `{type:"error"}` parts instead of throwing,
 * so the oracle here is "the stream yields NO error part". Drives the REAL proxy over genuine HTTP with
 * the upstream shielded + PRE-MERGED at the wire level (every `.delta` frame removed, content_part
 * lifecycle kept — the safe merge shape proven by the official-SDK probe), then consumes it through
 * `@ai-sdk/openai`'s `LanguageModelV4.doStream`.
 */

import { createOpenAI } from "@ai-sdk/openai"
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

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import type { BlockFixture } from "../responses/fixtures/buffered-merge-blocks"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  functionCallBlock,
  messageMultiPartBlock,
  reasoningSummaryBlock,
  refusalBlock,
} from "../responses/fixtures/buffered-merge-blocks"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"
import {
  //
  createSseResponse,
  scriptedUpstream,
} from "./harness/upstream-script"

const MODEL = "gpt-resp"

const ev = (obj: { type: string } & Record<string, unknown>): string => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
const DONE = "data: [DONE]\n\n"

const created = (): string =>
  ev({
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_up_1",
      object: "response",
      created_at: 1,
      status: "in_progress",
      model: MODEL,
      output: [],
      usage: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  })
const completedFull = (seq: number, output: Array<unknown>): string =>
  ev({
    type: "response.completed",
    sequence_number: seq,
    response: {
      id: "resp_up_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model: MODEL,
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  })

/** The drop-delta merge shape at the wire level: remove every `.delta` frame, keep the content_part
 *  lifecycle + terminal `.done` (the safe shape — dropping a `.added` would be the landmine). */
const merged = (fx: BlockFixture): Array<string> =>
  fx.frames.filter((f) => !f.event?.endsWith(".delta")).map((f) => `event: ${f.event ?? ""}\ndata: ${f.data ?? ""}\n\n`)

describe("@ai-sdk/openai delta-sensitive consumer vs buffered-merge drop-delta", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy

  beforeAll(() => {
    proxy = serveInProcess()
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      normalizeResponsesCallIds: true,
      fixResponsesStreamIds: true,
      upstreamWebSocket: false,
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  async function streamParts(frames: Array<string>): Promise<Array<{ type: string }>> {
    setUpstreamFetchForTests(scriptedUpstream(() => createSseResponse(frames)).handler)
    const provider = createOpenAI({ apiKey: "test-key", baseURL: proxy.baseURL })
    const model = provider.responses(MODEL)
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts: Array<{ type: string }> = []
    for await (const part of result.stream) parts.push(part as { type: string })
    return parts
  }

  test.each([
    ["function_call", functionCallBlock, 9, "tool-call"],
    ["message multi-part", messageMultiPartBlock, 9, "text-start"],
    ["refusal", refusalBlock, 9, "text-start"],
    ["reasoning summary", reasoningSummaryBlock, 9, "reasoning-start"],
  ] as const)("%s: the merged (delta-dropped) wire yields NO error part + reconstructs content cleanly", async (_label, blockFn, seq, contentType) => {
    const fx = blockFn(0, "item_1")
    const parts = await streamParts([created(), ...merged(fx), completedFull(seq, [fx.finalItem]), DONE])
    const types = parts.map((p) => p.type)
    expect(parts.filter((p) => p.type === "error")).toEqual([]) // @ai-sdk models stream errors as {type:"error"} parts, NOT throws
    // Teeth: the SDK actually PROCESSED the no-delta wire (not a silent no-op) — it reached a clean
    // `finish` AND emitted the block's reconstructed content part. `@ai-sdk` is even more tolerant than
    // the official `openai` SDK (it does NOT throw on the content_part.added landmine — it rebuilds from
    // `response.completed`'s full output), so content reconstruction is the meaningful oracle here.
    expect(types).toContain("finish")
    expect(types).toContain(contentType)
  })
})
