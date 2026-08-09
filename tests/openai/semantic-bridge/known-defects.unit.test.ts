import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"
import type { ResponsesInputItem } from "~/types/api/openai-responses"

import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { extractEncryptedReasoning } from "~/lib/anthropic/synthetic-reasoning"
import { setModels } from "~/lib/models/cache"
import { translateAnthropicResponseToResponses } from "~/lib/openai/translate/anthropic-to-responses"
import { translateAnthropicToResponses } from "~/lib/openai/translate/anthropic-to-responses-request"
import { createAnthropicToResponsesStreamTranslator } from "~/lib/openai/translate/anthropic-to-responses-stream"
import { translateResponsesResponseToAnthropic } from "~/lib/openai/translate/responses-to-anthropic"
import { translateResponsesToAnthropicRequest } from "~/lib/openai/translate/responses-to-anthropic-request"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import {
  //
  createResponsesSdkOracle,
  type ResponsesSdkOracle,
} from "../../helpers/protocol-oracles"
import {
  //
  anthropicPayload,
  encryptedOnlyOutput,
  multiReasoningOutput,
  orderedAnthropicAssistant,
  orderedResponsesInput,
  responsesPayload,
  responsesResponse,
  sameModelClaudeAssistant,
  sameModelClaudeToolResult,
  scenarioBReasoningHistory,
} from "./fixtures"

const exchange = { responseId: "resp_known_loss", itemId: "item_known_loss", resolvedModel: "claude-opus-4.8" }

function inputItems(result: { input: string | Array<ResponsesInputItem> }): Array<ResponsesInputItem> {
  if (typeof result.input === "string") throw new Error("expected array-shaped Responses input")
  return result.input
}

function event(obj: unknown): ServerSentEventMessage {
  return { event: (obj as { type: string }).type, data: JSON.stringify(obj) }
}

function responseSse(obj: { type: string } & Record<string, unknown>): string {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
}

function renderAnthropicStream(events: Array<ServerSentEventMessage>): Array<ServerSentEventMessage> {
  const translator = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", exchange)
  return [...events.flatMap((frame) => translator.renderFrame(frame).map((step) => step.frame)), ...translator.flush().map((step) => step.frame)]
}

function parseFrames(frames: Array<ServerSentEventMessage>): Array<Record<string, unknown>> {
  return frames.map((frame) => JSON.parse(frame.data ?? "{}") as Record<string, unknown>)
}

describe("semantic bridge C0.2 — current known losses", () => {
  useIsolatedRuntime()

  let responsesOracle: ResponsesSdkOracle

  beforeAll(() => {
    responsesOracle = createResponsesSdkOracle("gpt-resp")
  })

  beforeEach(() => {
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", upstreamWebSocket: false })
    setModels({ object: "list", data: [mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  })

  afterAll(() => responsesOracle.close())

  test("KNOWN-LOSS：Anthropic→Responses stream omits response.output_item.added for text, so the official OpenAI SDK rejects it；C8.1 should emit the complete SDK-consumable lifecycle", async () => {
    // KNOWN-LOSS：官方 OpenAI SDK 因缺 output item lifecycle 拒绝当前流；C8.1 后应改为完整可消费 lifecycle。
    const translated = renderAnthropicStream([
      event({ type: "message_start", message: { id: "msg_1", model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 0 } } }),
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      event({ type: "message_stop" }),
    ])
    const wire = translated.map((frame) => responseSse(JSON.parse(frame.data ?? "{}") as { type: string } & Record<string, unknown>))
    let error: Error | undefined
    try {
      await responsesOracle.finalResponseOf(wire)
    } catch (caught) {
      error = caught as Error
    }
    expect(error?.message).toContain("missing output at index 0")
  })

  test("KNOWN-LOSS：both request translators reorder text/tool source ordinals；C4 should preserve source order unless a named target rule requires otherwise", () => {
    // KNOWN-LOSS：两向 request translator 当前都重排 text/tool；C4 后应改为默认保持 source ordinal。
    const anthropicTypes = inputItems(translateAnthropicToResponses(anthropicPayload([orderedAnthropicAssistant]))).map((item) => item.type)
    expect(anthropicTypes).toEqual(["message", "function_call"])
    const reverse = translateResponsesToAnthropicRequest(responsesPayload(orderedResponsesInput))
    expect((reverse.messages[0].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "tool_use"])
  })

  test("KNOWN-LOSS：all four server-tool quadrants lose native structure today；C5 should preserve or explicitly degrade each quadrant with correlation", () => {
    // KNOWN-LOSS：server-tool 四格当前都丢原生结构；C5 后应改为逐格保留或带 correlation ID 降级。
    const requestUse = inputItems(
      translateAnthropicToResponses(
        anthropicPayload([
          {
            role: "assistant",
            content: [{ type: "server_tool_use", id: "srv-history", name: "web_search", input: { query: "q" } } as never],
          },
        ]),
      ),
    )
    const requestResult = inputItems(
      translateAnthropicToResponses(
        anthropicPayload([
          {
            role: "user",
            content: [
              {
                type: "web_search_tool_result",
                tool_use_id: "srv-history",
                content: [{ type: "web_search_result", url: "https://x", title: "x", encrypted_content: "opaque" }],
              } as never,
            ],
          },
        ]),
      ),
    )
    const nonStream = translateAnthropicResponseToResponses(
      {
        id: "msg_server",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [{ type: "server_tool_use", id: "srv-live", name: "web_search", input: { query: "q" } } as never],
        stop_reason: "end_turn",
        stop_sequence: null,
        container: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 } as never,
      },
      exchange,
    )
    const stream = parseFrames(
      renderAnthropicStream([
        event({ type: "message_start", message: { id: "msg_server", model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 0 } } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv-live", name: "web_search", input: {} } }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ]),
    )
    expect(requestUse).toEqual([])
    expect(requestResult).toEqual([])
    expect(nonStream.output).toEqual([])
    expect(stream.some((frame) => JSON.stringify(frame).includes("srv-live"))).toBe(false)
  })

  test("KNOWN-LOSS：Scenario B strips the response carrier but the request consumer still reconstructs it；C7 should apply the same strip policy on the request leg", () => {
    // KNOWN-LOSS：Scenario B 当前只作用于 response renderer；C7 后 request consumer 也应剥离 opaque carrier。
    const translated = translateAnthropicToResponses(anthropicPayload([scenarioBReasoningHistory]))
    const reasoning = inputItems(translated).find((item) => item.type === "reasoning")
    expect(reasoning?.encrypted_content).toBe("opaque-must-strip")
  })

  test("KNOWN-LOSS：multiple reasoning items collapse into one thinking block and the last encrypted payload wins；C8.2 should keep item boundaries and opaque values independent", async () => {
    // KNOWN-LOSS：多个 reasoning item 当前合并明文且仅保留最后一个 opaque；C8.2 后应改为逐 item 独立。
    const { response } = translateResponsesResponseToAnthropic(responsesResponse(multiReasoningOutput))
    const thinking = response.content.filter((block) => block.type === "thinking") as Array<{ type: "thinking"; thinking: string; signature: string }>
    expect(thinking).toHaveLength(1)
    expect(thinking[0].thinking).toBe("firstsecond")
    expect(extractEncryptedReasoning(thinking[0].signature)).toBe("enc-second")
  })

  test("KNOWN-LOSS：non-stream encrypted-only reasoning is dropped and replaced by an empty text block；C8.2 should preserve the opaque-only reasoning item", () => {
    // KNOWN-LOSS：encrypted-only reasoning 当前变成空 text；C8.2 后应改为保留 opaque-only reasoning。
    const { response } = translateResponsesResponseToAnthropic(responsesResponse(encryptedOnlyOutput))
    expect(response.content).toEqual([{ type: "text", text: "" }])
  })

  test("KNOWN-LOSS：a streamed function call with authoritative start arguments but no deltas completes with empty arguments；C8.1 should use the authoritative item arguments", () => {
    // KNOWN-LOSS：无 arguments delta 时当前输出空 arguments；C8.1 后应改为采用 start/done authoritative arguments。
    const translator = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", exchange)
    const frames = [
      event({ type: "message_start", message: { id: "msg_args", model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 0 } } }),
      event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_args", name: "lookup", input: { q: 42 } } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
    ]
    for (const frame of frames) translator.renderFrame(frame)
    const flushed = parseFrames(translator.flush().map((step) => step.frame))
    const done = flushed.find((frame) => frame.type === "response.function_call_arguments.done")
    expect(done?.arguments).toBe("")
  })

  test("KNOWN-LOSS：an incomplete payload is emitted under response.completed；C8.1 should emit response.incomplete without rewriting the terminal", () => {
    // KNOWN-LOSS：incomplete payload 当前仍冠名 response.completed；C8.1 后应改为 response.incomplete。
    const frames = parseFrames(
      renderAnthropicStream([
        event({ type: "message_start", message: { id: "msg_incomplete", model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 0 } } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } }),
      ]),
    )
    const terminal = frames.at(-1)
    expect(terminal?.type).toBe("response.completed")
    expect((terminal?.response as { status: string }).status).toBe("incomplete")
  })

  test("KNOWN-LOSS：top-level capabilities are silently pruned in both directions；C6 should reject or emit typed degradation instead of silent loss", () => {
    // KNOWN-LOSS：两向顶层 capability 当前静默裁剪；C6 后应改为 fail-closed 或 typed degradation。
    const forward = translateAnthropicToResponses(
      anthropicPayload([{ role: "user", content: "x" }], {
        top_k: 7,
        stop_sequences: ["STOP"],
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] } as never,
      }),
    )
    const reverse = translateResponsesToAnthropicRequest(
      responsesPayload([{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }], {
        previous_response_id: "resp_previous",
        truncation: "auto",
        context_management: [{ type: "compaction", compact_threshold: 50_000 }] as never,
      }),
    )
    expect(JSON.stringify(forward)).not.toMatch(/top_k|stop_sequences|context_management/)
    expect(JSON.stringify(reverse)).not.toMatch(/previous_response_id|truncation|context_management/)
  })
})

describe("semantic bridge C0.2 — invariants that must remain green", () => {
  let stateSnapshot: StateSnapshot

  beforeAll(() => {
    stateSnapshot = snapshotStateForTests()
    setStateForTests({ assistantBlockLayoutStrategy: "passthrough", thinkingBlockSanitizeCheck: false })
  })

  afterAll(() => restoreStateForTests(stateSnapshot))

  test("G4 guard：same-model Claude thinking／redacted_thinking／text／tool_use replay preserves source order, content, signature, and opaque data byte-for-byte through C11", () => {
    // G4 守护：同模型原生 Claude content 现在就应原序逐字回送，并持续保持到 C11。
    const source = structuredClone(sameModelClaudeAssistant)
    const toolResult = structuredClone(sameModelClaudeToolResult)
    const { payload } = runAnthropicPayloadRewrites(anthropicPayload([source, toolResult]), { toolNameMapper: null })
    const replayed: MessageParam = payload.messages[0]
    expect(payload.messages).toEqual([source, toolResult])
    if (!Array.isArray(replayed.content)) throw new Error("expected block-array assistant content")
    const blocks = replayed.content.map((block) => block as unknown as Record<string, unknown>)
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "redacted_thinking", "text", "tool_use"])
    expect(blocks[0].signature).toBe("claude-signature-byte-exact")
    expect(blocks[1].data).toBe("redacted-byte-exact")
  })
})
