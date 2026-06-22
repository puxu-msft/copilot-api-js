/**
 * Stage A Task2(A0) — request-rewrite migration golden (driver S3).
 *
 * Locks that moving the Anthropic request sanitize chain from `codec.parse` (S1)
 * into the driver's S3 `runRewriteIn` is byte-equivalent for the request-history
 * side-channels the parse path records: `effectiveRequest.payload` (the post-rewrite
 * logical request) + `pipelineInfo` (preprocessing + sanitization + messageMapping).
 *
 * `effectiveRequest.payload` is asserted against the canonical chain output
 * (`runAnthropicPayloadRewrites`, itself byte-locked by request-rewrites.it.test.ts)
 * — this proves the handler-v4 path applies the chain regardless of WHERE (S1 vs S3),
 * and is robust to the large Claude-Code stub list `preprocessTools` injects. The
 * small `pipelineInfo` object is locked inline (captured from the pre-change path).
 *
 * Recording-timing quirk locked here: only orphan/tool-removal/system-reminder/
 * preprocessing changes record `pipelineInfo` (the parse `if` gate); inline-system
 * conversion and tool-DEFINITION renames change the payload but record NO pipelineInfo.
 *
 * Reject-path note: a model rejected at S2 (decideRoute) never reaches S3, so after
 * A0 a rejected request records NO sanitization pipelineInfo (pre-A0 it did, because
 * parse sanitized before decideRoute). This is an intentional improvement — we lock
 * only the stable reject facts (status 400 + no effectiveRequest, true pre+post).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import {
  //
  clearHistory,
  getHistory,
} from "~/lib/history"
import {
  //
  setModelOverrides,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createFullTestApp } from "../helpers/test-app"

const MODEL = "claude-sonnet-4.6"

function nonStreamBody(): string {
  return JSON.stringify({
    id: "msg-req-golden",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

const upstreamMock = mock(() => Promise.resolve(new Response(nonStreamBody(), { status: 200, headers: { "content-type": "application/json" } })))

const app = createFullTestApp()

function injectAnthropicModel(): void {
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  setModelOverrides({})
}

function payload(messages: Array<unknown>, extra?: Partial<MessagesPayload>): MessagesPayload {
  return { model: MODEL, max_tokens: 256, stream: false, messages, ...extra } as unknown as MessagesPayload
}

/**
 * The canonical chain output the codec applies — built with the SAME tool-name mapper
 * the codec derives (`buildAnthropicToolNameMapper(tools, model, vendor)`). For the
 * suite's scenarios the route's `preprocessAnthropicMessages` (dedup + strip-read-tags)
 * is identity (no read-tags / dup tool calls / system param), so the parse baseline
 * equals the posted body.
 */
function oracleEffective(input: MessagesPayload): MessagesPayload {
  const mapper = buildAnthropicToolNameMapper(input.tools, input.model, "Anthropic")
  return runAnthropicPayloadRewrites(input, { toolNameMapper: mapper }).payload
}

async function postAndEntry(body: MessagesPayload): Promise<{ effective: unknown; pipelineInfo: unknown }> {
  injectAnthropicModel()
  clearHistory()
  await app.request("/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
  return { effective: entry?.effectiveRequest?.payload, pipelineInfo: entry?.pipelineInfo }
}

describe("request-rewrite migration golden (codec.parse → driver S3)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamMock.mockClear()
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0 })
    applyFetchMock(upstreamMock)
  })

  test("plain conversation: effectiveRequest = chain output, no pipelineInfo (no change)", async () => {
    const input = payload([{ role: "user", content: "hello" }])
    const { effective, pipelineInfo } = await postAndEntry(input)
    expect(effective).toEqual(oracleEffective(input))
    expect(pipelineInfo).toBeUndefined()
  })

  test("orphan tool_result dropped: effectiveRequest = chain output + pipelineInfo recorded (sanitization + messageMapping)", async () => {
    const input = payload([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }] },
      { role: "user", content: "follow up" },
    ])
    const { effective, pipelineInfo } = await postAndEntry(input)
    expect(effective).toEqual(oracleEffective(input))
    expect(pipelineInfo).toEqual({
      preprocessing: { strippedReadTagCount: 0, dedupedToolCallCount: 0 },
      sanitization: [
        {
          totalBlocksRemoved: 1,
          orphanedToolUseCount: 0,
          orphanedToolResultCount: 1,
          fixedNameCount: 0,
          emptyTextBlocksRemoved: 0,
          emptyThinkingBlocksRemoved: 0,
          systemReminderRemovals: 0,
        },
      ],
      messageMapping: [0],
    })
  })

  test("inline-system convert: effectiveRequest reflects the convert, but NO pipelineInfo (gate excludes inlineSystemConverted)", async () => {
    setStateForTests({ systemMessagesSanitize: "as_user" })
    const input = payload([
      { role: "system", content: "inline sys" },
      { role: "user", content: "q" },
    ])
    const { effective, pipelineInfo } = await postAndEntry(input)
    expect(effective).toEqual(oracleEffective(input))
    expect(pipelineInfo).toBeUndefined()
  })

  test("tool-name sanitize: effectiveRequest = chain output (renamed + stubs), but NO pipelineInfo (tool-def rename ≠ fixedNameCount)", async () => {
    setStateForTests({ sanitizeToolNames: true })
    const input = payload([{ role: "user", content: "use a tool" }], {
      tools: [{ name: "weird tool name!", description: "d", input_schema: { type: "object", properties: {} } }] as unknown as Array<Tool>,
    })
    const { effective, pipelineInfo } = await postAndEntry(input)
    expect(effective).toEqual(oracleEffective(input))
    expect(pipelineInfo).toBeUndefined()
  })

  test("reject (non-anthropic model): status 400, no effectiveRequest (reject precedes S4 sampling)", async () => {
    injectAnthropicModel()
    setModels({ object: "list", data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
    clearHistory()
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload([{ role: "user", content: "q" }], { model: "gpt-4o" })),
    })
    expect(res.status).toBe(400)
    const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
    expect(entry?.effectiveRequest?.payload).toBeUndefined()
  })
})
