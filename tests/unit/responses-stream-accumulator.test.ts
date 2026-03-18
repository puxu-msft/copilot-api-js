import { describe, expect, test } from "bun:test"

import {
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
  finalizeResponsesContent,
} from "~/lib/openai/responses-stream-accumulator"

// ============================================================================
// createResponsesStreamAccumulator
// ============================================================================

describe("createResponsesStreamAccumulator", () => {
  test("initializes with default zero values", () => {
    const acc = createResponsesStreamAccumulator()
    expect(acc.model).toBe("")
    expect(acc.inputTokens).toBe(0)
    expect(acc.outputTokens).toBe(0)
    expect(acc.reasoningTokens).toBe(0)
    expect(acc.cachedInputTokens).toBe(0)
    expect(acc.rawContent).toBe("")
    expect(acc.status).toBe("")
    expect(acc.responseId).toBe("")
    expect(acc.toolCalls).toEqual([])
    expect(acc.toolCallMap.size).toBe(0)
    expect(acc.contentParts).toEqual([])
  })
})

// ============================================================================
// accumulateResponsesStreamEvent
// ============================================================================

describe("accumulateResponsesStreamEvent", () => {
  // ── Response lifecycle events ──

  test("extracts model and responseId from response.created", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.created",
        response: { id: "resp_123", model: "gpt-4o", status: "in_progress" },
      } as any,
      acc,
    )
    expect(acc.model).toBe("gpt-4o")
    expect(acc.responseId).toBe("resp_123")
  })

  test("extracts model from response.in_progress", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.in_progress",
        response: { id: "resp_456", model: "claude-sonnet-4", status: "in_progress" },
      } as any,
      acc,
    )
    expect(acc.model).toBe("claude-sonnet-4")
    expect(acc.responseId).toBe("resp_456")
  })

  test("extracts status from response.failed", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.failed",
        response: { id: "resp_789", model: "gpt-4o", status: "failed" },
      } as any,
      acc,
    )
    expect(acc.status).toBe("failed")
  })

  test("extracts status from response.incomplete", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.incomplete",
        response: { id: "resp_abc", model: "gpt-4o", status: "incomplete" },
      } as any,
      acc,
    )
    expect(acc.status).toBe("incomplete")
  })

  // ── response.completed with usage ──

  test("extracts usage from response.completed", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.completed",
        response: {
          id: "resp_done",
          model: "gpt-4o",
          status: "completed",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      } as any,
      acc,
    )
    expect(acc.status).toBe("completed")
    expect(acc.model).toBe("gpt-4o")
    expect(acc.inputTokens).toBe(100)
    expect(acc.outputTokens).toBe(50)
  })

  test("extracts reasoning_tokens from output_tokens_details", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.completed",
        response: {
          id: "resp_r",
          model: "gpt-4o",
          status: "completed",
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            output_tokens_details: { reasoning_tokens: 30 },
          },
        },
      } as any,
      acc,
    )
    expect(acc.reasoningTokens).toBe(30)
  })

  test("extracts cached_tokens from input_tokens_details", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.completed",
        response: {
          id: "resp_c",
          model: "gpt-4o",
          status: "completed",
          usage: {
            input_tokens: 300,
            output_tokens: 60,
            input_tokens_details: { cached_tokens: 150 },
          },
        },
      } as any,
      acc,
    )
    expect(acc.cachedInputTokens).toBe(150)
  })

  test("handles response.completed without usage", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.completed",
        response: { id: "resp_no_usage", model: "gpt-4o", status: "completed" },
      } as any,
      acc,
    )
    expect(acc.inputTokens).toBe(0)
    expect(acc.outputTokens).toBe(0)
    expect(acc.reasoningTokens).toBe(0)
    expect(acc.cachedInputTokens).toBe(0)
  })

  test("handles response.completed with partial usage details", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.completed",
        response: {
          id: "resp_partial",
          model: "gpt-4o",
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 10 },
            // no input_tokens_details
          },
        },
      } as any,
      acc,
    )
    expect(acc.reasoningTokens).toBe(10)
    expect(acc.cachedInputTokens).toBe(0) // default when missing
  })

  // ── Text accumulation ──

  test("accumulates text delta events", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Hello ",
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "world!",
      } as any,
      acc,
    )
    expect(acc.contentParts).toEqual(["Hello ", "world!"])
  })

  // ── Function call accumulation ──

  test("tracks function call from output_item.added", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "search",
          arguments: "",
          status: "in_progress",
        },
      } as any,
      acc,
    )
    expect(acc.toolCallMap.has(0)).toBe(true)
    const tcAcc = acc.toolCallMap.get(0)!
    expect(tcAcc.name).toBe("search")
    expect(tcAcc.callId).toBe("call_abc")
  })

  test("accumulates function call arguments", () => {
    const acc = createResponsesStreamAccumulator()
    // First add the function call
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_2",
          call_id: "call_def",
          name: "read_file",
          arguments: "",
          status: "in_progress",
        },
      } as any,
      acc,
    )
    // Then accumulate arguments
    accumulateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_2",
        delta: '{"path":',
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_2",
        delta: '"/tmp/x"}',
      } as any,
      acc,
    )
    const tcAcc = acc.toolCallMap.get(1)!
    expect(tcAcc.argumentParts).toEqual(['{"path":', '"/tmp/x"}'])
  })

  test("finalizes function call on arguments.done", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_3",
          call_id: "call_ghi",
          name: "execute",
          arguments: "",
          status: "in_progress",
        },
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_3",
        delta: '{"cmd":"ls"}',
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc_3",
        arguments: '{"cmd":"ls"}',
      } as any,
      acc,
    )
    expect(acc.toolCalls).toHaveLength(1)
    expect(acc.toolCalls[0].name).toBe("execute")
    expect(acc.toolCalls[0].arguments).toBe('{"cmd":"ls"}')
    expect(acc.toolCalls[0].callId).toBe("call_ghi")
  })

  test("finalizes function call on output_item.done if not already finalized", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_4",
          call_id: "call_jkl",
          name: "write",
          arguments: "",
          status: "in_progress",
        },
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_4",
        delta: '{"data":"test"}',
      } as any,
      acc,
    )
    // Finalize via output_item.done (no arguments.done received)
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_4",
          call_id: "call_jkl",
          name: "write",
          arguments: '{"data":"test"}',
          status: "completed",
        },
      } as any,
      acc,
    )
    expect(acc.toolCalls).toHaveLength(1)
    expect(acc.toolCalls[0].name).toBe("write")
  })

  test("does not duplicate function calls finalized via arguments.done", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_5",
          call_id: "call_mno",
          name: "list",
          arguments: "",
          status: "in_progress",
        },
      } as any,
      acc,
    )
    // Finalize via arguments.done first
    accumulateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc_5",
        arguments: "{}",
      } as any,
      acc,
    )
    // Then output_item.done comes
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_5",
          call_id: "call_mno",
          name: "list",
          arguments: "{}",
          status: "completed",
        },
      } as any,
      acc,
    )
    // Should not duplicate
    expect(acc.toolCalls).toHaveLength(1)
  })

  // ── Reasoning / unknown events (pass-through) ──

  test("ignores reasoning summary events without crashing", () => {
    const acc = createResponsesStreamAccumulator()
    // These events should be silently ignored (proxy just forwards them)
    accumulateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "thinking...",
        sequence_number: 1,
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_part.done",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "thinking..." },
        sequence_number: 2,
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
        sequence_number: 0,
      } as any,
      acc,
    )
    accumulateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        text: "thinking...",
        sequence_number: 3,
      } as any,
      acc,
    )
    // No crash, no state change
    expect(acc.contentParts).toEqual([])
    expect(acc.toolCalls).toEqual([])
  })

  test("ignores unknown event types gracefully", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "some.unknown.event",
      } as any,
      acc,
    )
    // No crash, no state change
    expect(acc.model).toBe("")
    expect(acc.inputTokens).toBe(0)
  })

  // ── Non-function output_item.added is ignored ──

  test("ignores non-function-call output_item.added", () => {
    const acc = createResponsesStreamAccumulator()
    accumulateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      } as any,
      acc,
    )
    expect(acc.toolCallMap.size).toBe(0)
  })
})

// ============================================================================
// finalizeResponsesContent
// ============================================================================

describe("finalizeResponsesContent", () => {
  test("joins content parts and returns result", () => {
    const acc = createResponsesStreamAccumulator()
    acc.contentParts.push("Hello ", "world!")
    const result = finalizeResponsesContent(acc)
    expect(result).toBe("Hello world!")
  })

  test("returns empty string when content parts are empty and no existing content", () => {
    const acc = createResponsesStreamAccumulator()
    const result = finalizeResponsesContent(acc)
    expect(result).toBe("")
  })

  test("returns existing content when parts are empty", () => {
    const acc = createResponsesStreamAccumulator()
    acc.rawContent = "Previously set content"
    const result = finalizeResponsesContent(acc)
    expect(result).toBe("Previously set content")
  })

  test("clears content parts after finalization", () => {
    const acc = createResponsesStreamAccumulator()
    acc.contentParts.push("abc", "def")
    finalizeResponsesContent(acc)
    expect(acc.contentParts).toEqual([])
  })
})
