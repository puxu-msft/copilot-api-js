/**
 * Phase 5 reverse round-trip — END-TO-END F→D byte-exact carrier oracle (RFC
 * 2026-07-14-anthropic-responses-direct-bridge §4.2/§4.4, merged-state review MINOR-2).
 *
 * The unit suites for the individual legs (`anthropic-to-responses.unit.test.ts`,
 * `anthropic-to-responses-stream.unit.test.ts`, `responses-to-anthropic-request.unit.test.ts`,
 * `claude-signature-carrier.unit.test.ts`) each verify a SEGMENT of the round-trip in isolation:
 * F renders a carrier (tested) → D consumes a carrier BUILT BY THE SAME PRIMITIVE in its own test
 * fixtures (tested) → the carrier primitive itself round-trips byte-exact (tested). That is
 * TRANSITIVE coverage, not direct: no single test feeds F's ACTUAL function output straight into
 * D's ACTUAL function input. This file closes that false-green window — the actual
 * `translateAnthropicResponseToResponses` (F, non-streaming) and
 * `createAnthropicToResponsesStreamTranslator` (F, streaming) outputs are fed VERBATIM into
 * `translateResponsesToAnthropicRequest` (D), and the reconstructed thinking block's `signature`
 * is asserted BYTE-EXACT equal to the ORIGINAL Claude signature — never merely "defined"/"non-empty".
 */

import type { Message as AnthropicResponse } from "@anthropic-ai/sdk/resources/messages"
import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { TranslateExchangeContext } from "~/lib/openai/translate"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { translateAnthropicResponseToResponses } from "~/lib/openai/translate/anthropic-to-responses"
import { createAnthropicToResponsesStreamTranslator } from "~/lib/openai/translate/anthropic-to-responses-stream"
import { translateResponsesToAnthropicRequest } from "~/lib/openai/translate/responses-to-anthropic-request"

const ctx: TranslateExchangeContext = { responseId: "resp_e2e", itemId: "item_e2e", resolvedModel: "claude-opus-4.8" }

/** A realistic-shaped Claude signature (matches the byte pattern observed in probe (e), FINDINGS.md). */
const REAL_CLAUDE_SIGNATURE =
  "EpICCokBCA8YAipAkdxBdM3kLmY5kjjU5zOzASAQcL3DFFfb2jejUZOPjuJrMtaWdV77O5dZQCe6TEwRUbfCexFp39fpi0cd4ykzlDIPY2xhdWRlLW9wdXMtNC04OABCCHRoaW5raW5nWiRjZWQxZjk4ZS0wYjUxLTQ2MTAtODI4Mi00ZTVkODgzODQ1NzQSDOs7RCuEB888OvuLNhoM3xA3Q2NqM5+1orROIjCe3TDVg0QV+sqXfUrhxYebYTWPknMSB3iCL160MLikP+K0wU9w6tWedTxyog121S8qNjVdBnPMoozhFNYKLKsPeEyEYB+zdGg05tT61eIEdiwvcsghbPUaikuA3KefU4ufD6pD8xfldxgB"

/** Minimal Anthropic response builder (mirrors anthropic-to-responses.unit.test.ts's fixture). */
function anthropicResponse(content: AnthropicResponse["content"]): AnthropicResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.8",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    container: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  }
}

describe("Phase 5 END-TO-END F→D round-trip (non-streaming): translateAnthropicResponseToResponses output fed verbatim into translateResponsesToAnthropicRequest", () => {
  test("the reconstructed Anthropic thinking block's signature is BYTE-EXACT equal to the original real Claude signature", () => {
    // F leg: real Claude response (real signature) → Responses response (the F leg under test, NOT a hand-built fixture).
    const responsesResult = translateAnthropicResponseToResponses(
      anthropicResponse([
        { type: "thinking", thinking: "step 1... step 2...", signature: REAL_CLAUDE_SIGNATURE },
        { type: "text", text: "the answer", citations: null },
      ]),
      ctx,
    )
    const reasoningOutputItem = responsesResult.output.find((o) => o.type === "reasoning")
    expect(reasoningOutputItem).toBeDefined()
    expect(reasoningOutputItem?.encrypted_content).toBeDefined()

    // Client echo: the SAME reasoning output item (id/summary/encrypted_content) comes back as a
    // Responses input item on the next turn — the wire-observable client behavior this bridge exists
    // to support (RFC §4.2).
    const echoedReasoningItem: ResponsesInputItem = {
      type: "reasoning",
      id: reasoningOutputItem?.id,
      summary: reasoningOutputItem?.summary,
      encrypted_content: reasoningOutputItem?.encrypted_content,
    }

    // D leg: feed F's ACTUAL output verbatim into D's ACTUAL input (the F→D leg under test, not two
    // independently-tested fixtures sharing a primitive).
    const anthropicPayload = translateResponsesToAnthropicRequest({
      model: "claude-opus-4.8",
      input: [echoedReasoningItem, { type: "message", role: "user", content: "next turn" }],
    } satisfies ResponsesPayload)

    const assistantMsg = anthropicPayload.messages.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    const content = assistantMsg?.content as Array<{ type: string; thinking?: string; signature?: string }>
    const reconstructedThinking = content.find((b) => b.type === "thinking")
    expect(reconstructedThinking).toBeDefined()

    // THE load-bearing assertion (probe (e): Claude's upstream rejects a signature altered by even ONE
    // byte — a weaker "defined"/"non-empty" check would NOT catch a lossy encode/decode bug across the
    // real F→D boundary).
    expect(reconstructedThinking?.signature).toBe(REAL_CLAUDE_SIGNATURE)
    expect(reconstructedThinking?.thinking).toBe("step 1... step 2...")
  })

  test("per-block: TWO real thinking blocks round-trip through the SAME F→D boundary, each preserving its OWN distinct signature byte-exact", () => {
    const sigA = "REAL-SIGNATURE-BLOCK-A-0123456789"
    const sigB = "REAL-SIGNATURE-BLOCK-B-9876543210"

    const responsesResult = translateAnthropicResponseToResponses(
      anthropicResponse([
        { type: "thinking", thinking: "first reasoning", signature: sigA },
        { type: "text", text: "interleaved", citations: null },
        { type: "thinking", thinking: "second reasoning", signature: sigB },
        { type: "text", text: "final", citations: null },
      ]),
      ctx,
    )
    const reasoningItems = responsesResult.output.filter((o) => o.type === "reasoning")
    expect(reasoningItems.length).toBe(2)

    const echoedItems: Array<ResponsesInputItem> = reasoningItems.map((r) => ({
      type: "reasoning",
      id: r.id,
      summary: r.summary,
      encrypted_content: r.encrypted_content,
    }))

    const anthropicPayload = translateResponsesToAnthropicRequest({
      model: "claude-opus-4.8",
      input: [...echoedItems, { type: "message", role: "user", content: "next" }],
    } satisfies ResponsesPayload)

    const assistantMsg = anthropicPayload.messages.find((m) => m.role === "assistant")
    const thinkingBlocks = (assistantMsg?.content as Array<{ type: string; signature?: string }>).filter((b) => b.type === "thinking")
    expect(thinkingBlocks.length).toBe(2)
    expect(thinkingBlocks.map((b) => b.signature)).toEqual([sigA, sigB])
  })
})

describe("Phase 5 END-TO-END F→D round-trip (streaming): createAnthropicToResponsesStreamTranslator output fed verbatim into translateResponsesToAnthropicRequest", () => {
  /** Drive the streaming F leg over a minimal Anthropic SSE sequence carrying a real thinking block + signature_delta. */
  function renderStreamingF(signature: string): Array<ServerSentEventMessage> {
    const t = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", ctx)
    const events: Array<ServerSentEventMessage> = [
      {
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_r",
            type: "message",
            role: "assistant",
            model: "claude-opus-4.8",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        event: "message_start",
      },
      {
        data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
        event: "content_block_start",
      },
      {
        data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "streamed reasoning" } }),
        event: "content_block_delta",
      },
      { data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } }), event: "content_block_delta" },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }), event: "content_block_stop" },
      { data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: {} }), event: "message_delta" },
    ]
    const out: Array<ServerSentEventMessage> = []
    for (const e of events) for (const s of t.renderFrame(e)) out.push(s.frame)
    for (const s of t.flush()) out.push(s.frame)
    return out
  }

  test("the streaming F leg's flushed reasoning output_item.done, fed into D, reconstructs a byte-exact signed thinking block", () => {
    const frames = renderStreamingF(REAL_CLAUDE_SIGNATURE)
    const doneEvent = frames.find((f) => {
      const parsed = JSON.parse(f.data ?? "{}") as { type: string; item?: { type: string } }
      return parsed.type === "response.output_item.done" && parsed.item?.type === "reasoning"
    })
    expect(doneEvent).toBeDefined()
    const reasoningItem = (JSON.parse(doneEvent?.data ?? "{}") as { item: ResponsesInputItem }).item

    const anthropicPayload = translateResponsesToAnthropicRequest({
      model: "claude-opus-4.8",
      input: [reasoningItem, { type: "message", role: "user", content: "next turn" }],
    } satisfies ResponsesPayload)

    const assistantMsg = anthropicPayload.messages.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as Array<{ type: string; thinking?: string; signature?: string }>
    const reconstructedThinking = content.find((b) => b.type === "thinking")
    expect(reconstructedThinking?.signature).toBe(REAL_CLAUDE_SIGNATURE)
    expect(reconstructedThinking?.thinking).toBe("streamed reasoning")
  })
})
