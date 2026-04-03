import { describe, expect, test } from "bun:test"

import type { MessagesPayload, Tool } from "~/types/api/anthropic"

import { preprocessTools } from "~/lib/anthropic/message-tools"

function makePayload(overrides: Partial<MessagesPayload> = {}): MessagesPayload {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    ...overrides,
  }
}

function getTool(tools: Array<Tool>, name: string): Tool {
  const tool = tools.find((entry) => entry.name === name)
  expect(tool).toBeDefined()
  if (!tool) {
    throw new Error(`Expected tool ${name} to exist`)
  }
  return tool
}

describe("preprocessTools", () => {
  test("enables tool search for Sonnet 4.6 and keeps tool_search first", () => {
    const result = preprocessTools(
      makePayload({
        tools: [{ name: "custom_search", input_schema: { type: "object" } }],
      }),
    )

    expect(result.tools?.[0]).toMatchObject({
      name: "tool_search_tool_regex",
      type: "tool_search_tool_regex_20251119",
      defer_loading: false,
    })
  })

  test("orders tools as tool_search, non-deferred, then deferred", () => {
    const result = preprocessTools(
      makePayload({
        tools: [
          { name: "custom_deferred_b", input_schema: { type: "object" } },
          { name: "Read", input_schema: { type: "object" } },
          { name: "history_tool", input_schema: { type: "object" } },
          { name: "custom_deferred_a", input_schema: { type: "object" } },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "history_tool", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done" }],
          },
        ],
      }),
    )

    const tools = result.tools ?? []
    const names = tools.map((tool) => tool.name)

    expect(names[0]).toBe("tool_search_tool_regex")
    expect(names.indexOf("Read")).toBeLessThan(names.indexOf("custom_deferred_a"))
    expect(names.indexOf("history_tool")).toBeLessThan(names.indexOf("custom_deferred_a"))
    expect(names.indexOf("custom_deferred_b")).toBeLessThan(names.indexOf("custom_deferred_a"))

    expect(getTool(tools, "Read").defer_loading).toBeUndefined()
    expect(getTool(tools, "history_tool").defer_loading).toBeUndefined()
    expect(getTool(tools, "custom_deferred_a").defer_loading).toBe(true)
    expect(getTool(tools, "custom_deferred_b").defer_loading).toBe(true)
  })
})
