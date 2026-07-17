/**
 * Anthropic Messages response → Responses response DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §3/§4.2, Phase 4 subtask E) — the `(openai-responses client, /v1/messages)` REVERSE non-streaming
 * response leg, replacing the two-hop Anthropic→CC→Responses translation with a single direct walk.
 *
 * Equivalence-zone assertions (byte-equivalent client-observed behavior vs the old two-hop path): text/
 * tool_use output-item shape, usage numeric fields, stop_reason→status single-hop remap for the reachable
 * CC-equivalent reasons. Improvement-zone assertions (independent from the old two-hop CC-intermediate
 * golden, phase-2-audit §③): usage reasoning_tokens/modality passthrough (Phase 3's MAJOR-fix precedent —
 * the CC-intermediate leg's `ccUsageToResponsesUsage` never carried reasoning_tokens at all, since CC
 * itself has no first-class reasoning-token field to relay); the 3 Anthropic-only stop_reason values
 * (`pause_turn`/`refusal`/genuine `tool_use`-without-CC-degradation) that a CC hop cannot represent
 * faithfully; and reasoning (thinking) rendering as a Responses `reasoning` output item's summary +
 * the Phase 5 byte-exact `claude-signature-carrier` round-trip of the real Claude signature.
 */

import type { Message as AnthropicResponse } from "@anthropic-ai/sdk/resources/messages"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { TranslateExchangeContext } from "~/lib/openai/translate"
import type {
  //
  ResponsesReasoningOutput,
} from "~/types/api/openai-responses"

import { extractClaudeSignature } from "~/lib/anthropic/claude-signature-carrier"
import { translateAnthropicResponseToResponses } from "~/lib/openai/translate/anthropic-to-responses"

/** Minimal Anthropic response builder. */
function anthropicResponse(content: AnthropicResponse["content"], over?: Partial<AnthropicResponse>): AnthropicResponse {
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
    ...over,
  }
}

const ctx: TranslateExchangeContext = { responseId: "resp_abc", itemId: "item_abc", clientModel: "claude-opus-4.8" }

describe("translateAnthropicResponseToResponses — top-level envelope", () => {
  test("id/model/status wrap through", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }]), ctx)
    expect(result.id).toBe("resp_abc")
    expect(result.object).toBe("response")
    expect(result.model).toBe("claude-opus-4.8")
  })

  test("model falls back to ctx.clientModel when the upstream response omits it", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }], { model: "" }), ctx)
    expect(result.model).toBe("claude-opus-4.8")
  })
})

describe("translateAnthropicResponseToResponses — text/tool_use output items (equivalence zone)", () => {
  test("text block → a message output item with output_text content", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "the answer is 42", citations: null }]), ctx)
    expect(result.output).toEqual([
      {
        id: "item_abc",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "the answer is 42", annotations: [] }],
      },
    ])
    expect(result.status).toBe("completed")
  })

  test("tool_use block → a function_call output item (id passed through verbatim as call_id)", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "tool_use", id: "toolu_01ABC", name: "get_weather", input: { city: "SF" }, caller: { type: "direct" } }], {
        stop_reason: "tool_use",
      }),
      ctx,
    )
    expect(result.output).toEqual([
      { type: "function_call", id: "toolu_01ABC", call_id: "toolu_01ABC", name: "get_weather", arguments: '{"city":"SF"}', status: "completed" },
    ])
    expect(result.status).toBe("completed")
  })

  test("text + tool_use (one Anthropic turn) → both output items, order preserved", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse(
        [
          { type: "text", text: "Let me check.", citations: null },
          { type: "tool_use", id: "toolu_x", name: "get_weather", input: { city: "NY" }, caller: { type: "direct" } },
        ],
        { stop_reason: "tool_use" },
      ),
      ctx,
    )
    expect(result.output.map((o) => o.type)).toEqual(["message", "function_call"])
  })

  test("malformed/empty content still yields a well-formed empty output array (never throws)", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([]), ctx)
    expect(result.output).toEqual([])
  })
})

describe("translateAnthropicResponseToResponses — reasoning rendering (IMPROVEMENT ZONE, R-DIRECTION-ASYMMETRY — real signature carried byte-exact via claude-signature-carrier, Phase 5)", () => {
  test("a thinking block renders as a LEADING reasoning output item with the plaintext summary", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([
        { type: "thinking", thinking: "step 1... step 2...", signature: "REAL-CLAUDE-SIGNATURE-abc123" },
        { type: "text", text: "the answer", citations: null },
      ]),
      ctx,
    )
    expect(result.output.map((o) => o.type)).toEqual(["reasoning", "message"])
    const reasoning = result.output[0] as ResponsesReasoningOutput
    expect(reasoning.summary).toEqual([{ type: "summary_text", text: "step 1... step 2..." }])
  })

  test("the real Claude signature is carried BYTE-EXACT in encrypted_content via the claude-signature-carrier (Phase 5 round-trip) — recoverable via extractClaudeSignature", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "thinking", thinking: "reasoning text", signature: "REAL-SIGNATURE-xyz" }]), ctx)
    const reasoning = result.output[0] as ResponsesReasoningOutput
    expect(reasoning.encrypted_content).toBeDefined()
    // Byte-exact recoverability is the load-bearing property (probe (e): Claude's upstream rejects a
    // signature altered by even one byte) — not merely "some carrier string is present".
    expect(extractClaudeSignature(reasoning.encrypted_content)).toBe("REAL-SIGNATURE-xyz")
    // The carrier is a distinguishable wire envelope, never the bare plaintext signature verbatim
    // (R-DIRECTION-ASYMMETRY: a stamped, recognizable carrier, not an indistinguishable raw blob).
    expect(reasoning.encrypted_content).toContain("copilot-api:claude-signature:v1:")
  })

  test("redacted_thinking blocks (no plaintext/no signature available) produce no reasoning item", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([
        { type: "redacted_thinking", data: "opaque-redacted-blob" },
        { type: "text", text: "hi", citations: null },
      ]),
      ctx,
    )
    expect(result.output.map((o) => o.type)).toEqual(["message"])
  })

  test("a server_tool_use block (server-side artifact, no Responses output-item equivalent on this leg) is safely dropped; the surrounding text still lands", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } as unknown as AnthropicResponse["content"][number],
        { type: "text", text: "visible answer", citations: null },
      ]),
      ctx,
    )
    expect(result.output.map((o) => o.type)).toEqual(["message"])
    expect(JSON.stringify(result.output)).toContain("visible answer")
  })

  test("no thinking block → no reasoning item (typical non-reasoning turn)", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }]), ctx)
    expect(result.output.every((o) => o.type !== "reasoning")).toBe(true)
  })

  test("per-block (not merged): TWO thinking blocks in the same turn produce TWO separate reasoning items, each with its OWN carried signature", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([
        { type: "thinking", thinking: "first", signature: "SIG-ONE" },
        { type: "text", text: "interleaved", citations: null },
        { type: "thinking", thinking: "second", signature: "SIG-TWO" },
        { type: "text", text: "final", citations: null },
      ]),
      ctx,
    )
    const reasoningItems = result.output.filter((o): o is ResponsesReasoningOutput => o.type === "reasoning")
    expect(reasoningItems.length).toBe(2)
    expect(reasoningItems.map((r) => r.summary)).toEqual([
      [{ type: "summary_text", text: "first" }],
      [{ type: "summary_text", text: "second" }],
    ])
    expect(reasoningItems.map((r) => extractClaudeSignature(r.encrypted_content))).toEqual(["SIG-ONE", "SIG-TWO"])
    // Distinct ids (no accidental id collision now that reasoning is per-block).
    expect(new Set(reasoningItems.map((r) => r.id)).size).toBe(2)
  })
})

describe("translateAnthropicResponseToResponses — RFC §4.3 scenario A/B (Phase 5 model_translation wiring)", () => {
  test("scenario B (stripThinkingSignature=true) NEVER populates encrypted_content — plaintext summary still renders", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "thinking", thinking: "still shown", signature: "SHOULD-NOT-BE-CARRIED" }]),
      ctx,
      { stripThinkingSignature: true },
    )
    const reasoning = result.output[0] as ResponsesReasoningOutput
    expect(reasoning.encrypted_content).toBeUndefined()
    expect(reasoning.summary).toEqual([{ type: "summary_text", text: "still shown" }])
  })

  test("scenario A (default, no opts) DOES populate encrypted_content — the default is full round-trip", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "thinking", thinking: "shown", signature: "REAL-SIG" }]), ctx)
    const reasoning = result.output[0] as ResponsesReasoningOutput
    expect(extractClaudeSignature(reasoning.encrypted_content)).toBe("REAL-SIG")
  })
})

describe("translateAnthropicResponseToResponses — stop_reason → status (IMPROVEMENT ZONE, single-hop, no CC intermediate)", () => {
  test("end_turn → completed", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }], { stop_reason: "end_turn" }), ctx)
    expect(result.status).toBe("completed")
  })

  test("stop_sequence → completed", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "text", text: "hi", citations: null }], { stop_reason: "stop_sequence" }),
      ctx,
    )
    expect(result.status).toBe("completed")
  })

  test("max_tokens → incomplete + max_output_tokens reason", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }], { stop_reason: "max_tokens" }), ctx)
    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" })
  })

  test("tool_use → completed (function_call output items ARE the signal, not a degradation)", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "tool_use", id: "t1", name: "f", input: {}, caller: { type: "direct" } }], { stop_reason: "tool_use" }),
      ctx,
    )
    expect(result.status).toBe("completed")
  })

  test("pause_turn (Anthropic-only, no CC equivalent) → incomplete + an HONEST 'pause_turn' reason (not silently folded into max_output_tokens or dropped)", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }], { stop_reason: "pause_turn" }), ctx)
    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "pause_turn" })
  })

  test("refusal (Anthropic-only, no CC equivalent) → incomplete + an HONEST 'refusal' reason (NOT content_filter — Phase 3's corrected distinction applies symmetrically here)", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "", citations: null }], { stop_reason: "refusal" }), ctx)
    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "refusal" })
  })

  test("null stop_reason → completed (defensive default)", () => {
    const result = translateAnthropicResponseToResponses(anthropicResponse([{ type: "text", text: "hi", citations: null }], { stop_reason: null }), ctx)
    expect(result.status).toBe("completed")
  })
})

describe("translateAnthropicResponseToResponses — usage (MAJOR-fix-precedent verification: reasoning_tokens + modality MUST be forwarded)", () => {
  test("plain usage (no cache, no reasoning) → total-including-cache gross-up (Anthropic net → Responses total)", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "text", text: "hi", citations: null }], {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      }),
      ctx,
    )
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120 })
  })

  test("cache_read_input_tokens ADDED BACK into Responses input_tokens (Anthropic input_tokens is net-of-cache; Responses input_tokens is total-including-cache)", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "text", text: "hi", citations: null }], {
        usage: {
          input_tokens: 70,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      }),
      ctx,
    )
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 30 } })
  })

  test("cache_creation_input_tokens ADDED BACK + surfaced as cache_write_tokens", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "text", text: "hi", citations: null }], {
        usage: {
          input_tokens: 85,
          output_tokens: 20,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      }),
      ctx,
    )
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
    })
  })

  test("MAJOR FIX (mirrors Phase 3's precedent — reasoning_tokens is a REAL Anthropic field, output_tokens_details.thinking_tokens, and MUST be forwarded, never silently dropped)", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "text", text: "hi", citations: null }], {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: { thinking_tokens: 30 },
          server_tool_use: null,
          service_tier: null,
        },
      }),
      ctx,
    )
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150, output_tokens_details: { reasoning_tokens: 30 } })
  })

  test("zero thinking_tokens is NOT surfaced (non-zero-only convention, matches usage-normalize.ts's pruning discipline elsewhere)", () => {
    const result = translateAnthropicResponseToResponses(
      anthropicResponse([{ type: "text", text: "hi", citations: null }], {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: null,
          service_tier: null,
        },
      }),
      ctx,
    )
    expect(result.usage?.output_tokens_details).toBeUndefined()
  })
})
