/**
 * Unit tests for OpenAI tool-name sanitization (Chat Completions + Responses).
 *
 * Uses autoRestoreState to toggle `sanitizeToolNames` without leaking global
 * state across files.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import {
  //
  applyChatCompletionsToolNameSanitization,
  applyResponsesToolNameSanitization,
  buildChatCompletionsToolNameMapper,
  buildResponsesToolNameMapper,
  RESPONSES_NAME_BEARING_EVENTS,
  restoreChatCompletionsChunkToolNames,
  restoreChatCompletionsToolNames,
  restoreResponsesEventToolNames,
  restoreResponsesOutputToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

function enable(): void {
  setStateForTests({ sanitizeToolNames: true })
}

describe("Chat Completions tool-name sanitization", () => {
  test("disabled: mapper is null", () => {
    setStateForTests({ sanitizeToolNames: false })
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.8",
      messages: [],
      tools: [{ type: "function", function: { name: "mcp.tool" } }],
    }
    expect(buildChatCompletionsToolNameMapper(payload, "Anthropic")).toBeNull()
  })

  test("enabled: builds mapper and renames tool defs + tool_calls (claude strips dots)", () => {
    enable()
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.8",
      messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "mcp.tool", arguments: "{}" } }] }],
      tools: [{ type: "function", function: { name: "mcp.tool" } }],
    }
    const mapper = buildChatCompletionsToolNameMapper(payload, "Anthropic")
    expect(mapper).not.toBeNull()
    const out = applyChatCompletionsToolNameSanitization(payload, mapper)
    expect(out.tools?.[0].function.name).toBe("mcp_tool")
    expect(out.messages[0].tool_calls?.[0].function.name).toBe("mcp_tool")
  })

  test("renames a forced tool_choice name to match the renamed tool", () => {
    enable()
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.8",
      messages: [],
      tools: [{ type: "function", function: { name: "mcp.tool" } }],
      tool_choice: { type: "function", function: { name: "mcp.tool" } },
    }
    const mapper = buildChatCompletionsToolNameMapper(payload, "Anthropic")
    const out = applyChatCompletionsToolNameSanitization(payload, mapper)
    // Without this, upstream rejects with "Tool 'mcp.tool' not found in provided tools".
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "mcp_tool" } })
  })

  test("gpt keeps dots (no rename, mapper null)", () => {
    enable()
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [],
      tools: [{ type: "function", function: { name: "mcp.tool" } }],
    }
    expect(buildChatCompletionsToolNameMapper(payload, "OpenAI")).toBeNull()
  })

  test("restore non-streaming response tool_calls", () => {
    enable()
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.8",
      messages: [],
      tools: [{ type: "function", function: { name: "mcp.tool" } }],
    }
    const mapper = buildChatCompletionsToolNameMapper(payload, "Anthropic")
    const response = {
      id: "r1",
      object: "chat.completion",
      created: 0,
      model: "claude-opus-4.8",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls" as const,
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [{ id: "c1", type: "function" as const, function: { name: "mcp_tool", arguments: "{}" } }],
          },
        },
      ],
    } as ChatCompletionResponse
    const restored = restoreChatCompletionsToolNames(response, mapper)
    expect(restored.choices[0].message.tool_calls?.[0].function.name).toBe("mcp.tool")
  })

  test("restore streaming chunk tool_calls", () => {
    enable()
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.8",
      messages: [],
      tools: [{ type: "function", function: { name: "mcp.tool" } }],
    }
    const mapper = buildChatCompletionsToolNameMapper(payload, "Anthropic")!
    const chunk = { choices: [{ delta: { tool_calls: [{ function: { name: "mcp_tool" } }] } }] }
    const changed = restoreChatCompletionsChunkToolNames(chunk, mapper)
    expect(changed).toBe(true)
    expect(chunk.choices[0].delta.tool_calls[0].function.name).toBe("mcp.tool")
  })
})

describe("Responses tool-name sanitization", () => {
  test("enabled: renames tool defs + function_call input items", () => {
    enable()
    const payload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [{ type: "function_call", call_id: "c1", name: "mcp.tool", arguments: "{}" }],
      tools: [{ type: "function", name: "mcp.tool" }],
    }
    const mapper = buildResponsesToolNameMapper(payload, "Anthropic")
    expect(mapper).not.toBeNull()
    const out = applyResponsesToolNameSanitization(payload, mapper)
    const tool = out.tools?.[0]
    expect(tool && "name" in tool ? tool.name : undefined).toBe("mcp_tool")
    const item = Array.isArray(out.input) ? out.input[0] : undefined
    expect(item?.name).toBe("mcp_tool")
  })

  test("renames a forced tool_choice name to match the renamed tool", () => {
    enable()
    const payload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [],
      tools: [{ type: "function", name: "mcp.tool" }],
      tool_choice: { type: "function", name: "mcp.tool" },
    }
    const mapper = buildResponsesToolNameMapper(payload, "Anthropic")
    const out = applyResponsesToolNameSanitization(payload, mapper)
    expect(out.tool_choice).toEqual({ type: "function", name: "mcp_tool" })
  })

  test("renames a named custom tool_choice but leaves builtin choices untouched", () => {
    enable()
    const customPayload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [],
      tools: [{ type: "custom", name: "mcp.tool" }],
      tool_choice: { type: "custom", name: "mcp.tool" },
    }
    const mapper = buildResponsesToolNameMapper(customPayload, "Anthropic")
    const customOut = applyResponsesToolNameSanitization(customPayload, mapper)
    expect(customOut.tools).toEqual([{ type: "custom", name: "mcp_tool" }])
    expect(customOut.tool_choice).toEqual({ type: "custom", name: "mcp_tool" })

    const builtinPayload: ResponsesPayload = { ...customPayload, tool_choice: { type: "web_search" } }
    expect(applyResponsesToolNameSanitization(builtinPayload, mapper).tool_choice).toEqual({ type: "web_search" })
  })

  test("restore non-streaming output function_call names", () => {
    enable()
    const payload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [],
      tools: [{ type: "function", name: "mcp.tool" }],
    }
    const mapper = buildResponsesToolNameMapper(payload, "Anthropic")
    const response = {
      id: "resp_1",
      model: "claude-opus-4.8",
      output: [{ type: "function_call", id: "i1", call_id: "c1", name: "mcp_tool", arguments: "{}" }],
    } as unknown as ResponsesResponse
    const restored = restoreResponsesOutputToolNames(response, mapper)
    const out = restored.output[0] as { name?: string }
    expect(out.name).toBe("mcp.tool")
  })

  test("restore streaming output_item event function name", () => {
    enable()
    const payload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [],
      tools: [{ type: "function", name: "mcp.tool" }],
    }
    const mapper = buildResponsesToolNameMapper(payload, "Anthropic")!
    const event = { type: "response.output_item.added", item: { type: "function_call", name: "mcp_tool" } }
    const changed = restoreResponsesEventToolNames(event, mapper)
    expect(changed).toBe(true)
    expect(event.item.name).toBe("mcp.tool")
  })

  test("restore function names inside lifecycle event response.output[] (response.completed)", () => {
    // Regression: standard OpenAI SDK clients reconstruct the final result from
    // the terminal response.completed event's response.output[]. Names there
    // must be restored too, not only the per-item frames.
    enable()
    const payload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [],
      tools: [
        { type: "function", name: "mcp.tool" },
        { type: "function", name: "other.fn" },
      ],
    }
    const mapper = buildResponsesToolNameMapper(payload, "Anthropic")!
    const event = {
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [
          { type: "message", role: "assistant" },
          { type: "function_call", name: "mcp_tool", call_id: "c1" },
          { type: "function_call", name: "other_fn", call_id: "c2" },
        ],
      },
    }
    const changed = restoreResponsesEventToolNames(event, mapper)
    expect(changed).toBe(true)
    expect(event.response.output[1].name).toBe("mcp.tool")
    expect(event.response.output[2].name).toBe("other.fn")
    // non-function_call items untouched
    expect(event.response.output[0]).toEqual({ type: "message", role: "assistant" })
  })

  test("lifecycle event with no matching function_call names is a no-op (returns false)", () => {
    enable()
    const payload: ResponsesPayload = {
      model: "claude-opus-4.8",
      input: [],
      tools: [{ type: "function", name: "mcp.tool" }],
    }
    const mapper = buildResponsesToolNameMapper(payload, "Anthropic")!
    const event = { type: "response.created", response: { id: "r", output: [{ type: "message", role: "assistant" }] } }
    expect(restoreResponsesEventToolNames(event, mapper)).toBe(false)
  })

  test("RESPONSES_NAME_BEARING_EVENTS includes lifecycle + item events", () => {
    expect(RESPONSES_NAME_BEARING_EVENTS.has("response.completed")).toBe(true)
    expect(RESPONSES_NAME_BEARING_EVENTS.has("response.output_item.done")).toBe(true)
    expect(RESPONSES_NAME_BEARING_EVENTS.has("response.created")).toBe(true)
    // a delta/text event carries no name → excluded (caller skips JSON parse)
    expect(RESPONSES_NAME_BEARING_EVENTS.has("response.output_text.delta")).toBe(false)
  })
})
