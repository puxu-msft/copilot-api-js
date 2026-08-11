import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

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

  test("strips client cache_control from deferred tools but keeps it on non-deferred ones", () => {
    // Upstream rejects a tool carrying both fields: "Tools with defer_loading cannot use prompt caching".
    // Clients place breakpoints positionally (nanobot marks the last non-MCP tool and the tail tool), so a tool we choose to defer can arrive with one already attached.
    const result = preprocessTools(
      makePayload({
        tools: [
          { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
          { name: "write_stdin", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        ],
      }),
    )

    const tools = result.tools ?? []

    expect(getTool(tools, "write_stdin").defer_loading).toBe(true)
    expect(getTool(tools, "write_stdin").cache_control).toBeUndefined()

    // Negative control: a non-deferred tool keeps the client's breakpoint.
    expect(getTool(tools, "Read").defer_loading).toBeUndefined()
    expect(getTool(tools, "Read").cache_control).toEqual({ type: "ephemeral" })

    expect(tools.filter((tool) => tool.defer_loading === true && tool.cache_control)).toEqual([])
  })

  test("strips an orphan client defer_loading when tool search is not in effect", () => {
    // F27: pre-4.5 Claude is denied by the default-allow matcher, so tool_search is off for this model — same branch as the `toolSearchEnabled` master switch being off.
    // GHC has no tool-search mechanism here, so forwarding the client's flag either trips the unknown-tool-field retry or defers a tool that can never be loaded. Both cost a round-trip.
    const result = preprocessTools(
      makePayload({
        model: "claude-3-5-sonnet",
        tools: [{ name: "custom_tool", input_schema: { type: "object" }, defer_loading: true }],
      }),
    )

    const tools = result.tools ?? []

    expect(tools.find((tool) => tool.name === "tool_search_tool_regex")).toBeUndefined()
    expect(getTool(tools, "custom_tool").defer_loading).toBeUndefined()
  })

  test("strips client defer_loading from tools it deliberately keeps loaded", () => {
    // With tool_search on, a client flag surviving on a tool we chose to protect would defer it anyway and defeat the protection.
    const result = preprocessTools(
      makePayload({
        tools: [
          { name: "Read", input_schema: { type: "object" }, defer_loading: true },
          { name: "history_tool", input_schema: { type: "object" }, defer_loading: true },
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

    // `Read` is protected by NON_DEFERRED_TOOL_NAMES, `history_tool` by the message-history guard.
    expect(getTool(tools, "Read").defer_loading).toBeUndefined()
    expect(getTool(tools, "history_tool").defer_loading).toBeUndefined()
  })
})
