import { afterAll, describe, expect, test } from "bun:test"

import type { Tool } from "~/types/api/anthropic"
import type { StreamEvent } from "~/types/api/anthropic"

import { stripServerTools } from "~/lib/anthropic/message-tools"
import {
  createServerToolBlockFilter,
  filterServerToolBlocksFromResponse,
  isServerToolBlock,
} from "~/lib/anthropic/server-tool-filter"
import { state } from "~/lib/state"

// Helper to build minimal StreamEvent objects for filter testing.
// The filter only inspects .type, .index, and .content_block.type —
// full content block shapes are not needed.
function blockStart(index: number, blockType: string): StreamEvent {
  return { type: "content_block_start", index, content_block: { type: blockType } } as unknown as StreamEvent
}

function blockDelta(index: number): StreamEvent {
  return { type: "content_block_delta", index, delta: {} } as unknown as StreamEvent
}

function blockStop(index: number): StreamEvent {
  return { type: "content_block_stop", index } as unknown as StreamEvent
}

const originalStripServerTools = state.stripServerTools

afterAll(() => {
  state.stripServerTools = originalStripServerTools
})

// ============================================================================
// Request-side: stripServerTools
// ============================================================================

describe("stripServerTools", () => {
  describe("when stripping is disabled", () => {
    test("should return undefined for undefined input", () => {
      state.stripServerTools = false
      expect(stripServerTools(undefined)).toBeUndefined()
    })

    test("should return the same array reference (no allocation)", () => {
      state.stripServerTools = false
      const tools: Array<Tool> = [
        { name: "web_search", type: "web_search_20250305" },
        { name: "Bash", description: "Run bash", input_schema: { type: "object" } },
      ]
      const result = stripServerTools(tools)
      expect(result).toBe(tools) // same reference, not a copy
    })
  })

  describe("when stripping is enabled", () => {
    test("should strip web_search server tool", () => {
      state.stripServerTools = true
      const tools: Array<Tool> = [{ name: "web_search", type: "web_search_20250305" }]
      expect(stripServerTools(tools)).toBeUndefined()
    })

    test("should strip code_execution server tool", () => {
      state.stripServerTools = true
      const tools: Array<Tool> = [{ name: "code_execution", type: "code_execution_20250522" }]
      expect(stripServerTools(tools)).toBeUndefined()
    })

    test("should not strip custom tools", () => {
      state.stripServerTools = true
      const customTool: Tool = {
        name: "Bash",
        description: "Run bash commands",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      }
      const result = stripServerTools([customTool])!
      expect(result).toHaveLength(1)
      expect(result[0]).toBe(customTool) // same reference
    })

    test("should handle mixed server and custom tools", () => {
      state.stripServerTools = true
      const tools: Array<Tool> = [
        { name: "web_search", type: "web_search_20250305" },
        { name: "Bash", description: "Run bash", input_schema: { type: "object" } },
        { name: "web_fetch", type: "web_fetch_20250305" },
      ]
      const result = stripServerTools(tools)!
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("Bash")
    })

    test("should return undefined for empty array", () => {
      state.stripServerTools = true
      expect(stripServerTools([])).toBeUndefined()
    })

    test("should match tools by type prefix, not exact match", () => {
      state.stripServerTools = true
      // Different date versions should all match the same prefix
      const tools: Array<Tool> = [
        { name: "ws1", type: "web_search_20250101" },
        { name: "ws2", type: "web_search_20250305" },
        { name: "ws3", type: "web_search_20260101" },
      ]
      expect(stripServerTools(tools)).toBeUndefined()
    })
  })
})

// ============================================================================
// Response-side: isServerToolBlock
// ============================================================================

describe("isServerToolBlock", () => {
  test("should match server_tool_use", () => {
    expect(isServerToolBlock({ type: "server_tool_use" })).toBe(true)
  })

  test("should match tool_search_tool_result", () => {
    expect(isServerToolBlock({ type: "tool_search_tool_result" })).toBe(true)
  })

  test("should match web_search_tool_result", () => {
    expect(isServerToolBlock({ type: "web_search_tool_result" })).toBe(true)
  })

  test("should match code_execution_tool_result", () => {
    expect(isServerToolBlock({ type: "code_execution_tool_result" })).toBe(true)
  })

  test("should NOT match tool_result (client tool result)", () => {
    expect(isServerToolBlock({ type: "tool_result" })).toBe(false)
  })

  test("should NOT match tool_use (client tool use)", () => {
    expect(isServerToolBlock({ type: "tool_use" })).toBe(false)
  })

  test("should NOT match text", () => {
    expect(isServerToolBlock({ type: "text" })).toBe(false)
  })

  test("should NOT match thinking", () => {
    expect(isServerToolBlock({ type: "thinking" })).toBe(false)
  })
})

// ============================================================================
// Response-side: createServerToolBlockFilter (streaming)
// ============================================================================

describe("createServerToolBlockFilter", () => {
  test("should pass through non-server-tool events unchanged", () => {
    const filter = createServerToolBlockFilter()
    const data = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    expect(filter.rewriteEvent(blockStart(0, "text"), data)).toBe(data)
  })

  test("should suppress server_tool_use content_block_start", () => {
    const filter = createServerToolBlockFilter()
    const data = JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_123", name: "tool_search_tool_regex" },
    })
    expect(filter.rewriteEvent(blockStart(0, "server_tool_use"), data)).toBeNull()
  })

  test("should suppress tool_search_tool_result content_block_start", () => {
    const filter = createServerToolBlockFilter()
    const data = JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_123",
        content: { type: "tool_search_tool_search_result", tool_references: [] },
      },
    })
    expect(filter.rewriteEvent(blockStart(0, "tool_search_tool_result"), data)).toBeNull()
  })

  test("should suppress delta and stop events for filtered blocks", () => {
    const filter = createServerToolBlockFilter()

    // Block 0: server_tool_use (filtered)
    filter.rewriteEvent(blockStart(0, "server_tool_use"), "{}")

    // Delta for filtered block should be suppressed
    const deltaData = JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } })
    expect(filter.rewriteEvent(blockDelta(0), deltaData)).toBeNull()

    // Stop for filtered block should be suppressed
    const stopData = JSON.stringify({ type: "content_block_stop", index: 0 })
    expect(filter.rewriteEvent(blockStop(0), stopData)).toBeNull()
  })

  test("should remap indices when server tool blocks are interspersed", () => {
    const filter = createServerToolBlockFilter()

    // Block 0: text (keep → client index 0)
    const text0 = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })
    const result0 = filter.rewriteEvent(blockStart(0, "text"), text0)
    expect(result0).toBe(text0) // index 0 stays 0

    // Block 1: server_tool_use (filter)
    filter.rewriteEvent(blockStart(1, "server_tool_use"), "{}")

    // Block 2: tool_search_tool_result (filter)
    filter.rewriteEvent(blockStart(2, "tool_search_tool_result"), "{}")

    // Block 3: tool_use (keep → client index 1, remapped from 3)
    const toolUse3 = JSON.stringify({
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "toolu_abc", name: "Bash" },
    })
    const result3 = filter.rewriteEvent(blockStart(3, "tool_use"), toolUse3)
    const parsed3 = JSON.parse(result3!)
    expect(parsed3.index).toBe(1) // remapped: 3 → 1

    // Delta for block 3 should also get remapped index
    const delta3 = JSON.stringify({ type: "content_block_delta", index: 3, delta: { type: "text_delta" } })
    const deltaResult3 = filter.rewriteEvent(blockDelta(3), delta3)
    const parsedDelta3 = JSON.parse(deltaResult3!)
    expect(parsedDelta3.index).toBe(1)
  })

  test("should pass through non-content-block events (message_start, ping, etc.)", () => {
    const filter = createServerToolBlockFilter()
    const pingData = JSON.stringify({ type: "ping" })
    expect(filter.rewriteEvent({ type: "ping" } as unknown as StreamEvent, pingData)).toBe(pingData)

    const msgData = JSON.stringify({ type: "message_start", message: {} })
    expect(filter.rewriteEvent({ type: "message_start" } as unknown as StreamEvent, msgData)).toBe(msgData)
  })

  test("should return rawData for undefined parsed events", () => {
    const filter = createServerToolBlockFilter()
    expect(filter.rewriteEvent(undefined, "keepalive data")).toBe("keepalive data")
  })

  test("should not remap when no blocks are filtered", () => {
    const filter = createServerToolBlockFilter()

    // Block 0: text
    const text0 = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })
    expect(filter.rewriteEvent(blockStart(0, "text"), text0)).toBe(text0) // same string reference

    // Block 1: tool_use
    const toolUse1 = JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use" } })
    expect(filter.rewriteEvent(blockStart(1, "tool_use"), toolUse1)).toBe(toolUse1) // same string reference
  })
})

// ============================================================================
// Response-side: filterServerToolBlocksFromResponse (non-streaming)
// ============================================================================

describe("filterServerToolBlocksFromResponse", () => {
  test("should filter server_tool_use and server tool result blocks", () => {
    const response = {
      content: [
        { type: "text", text: "Hello" },
        { type: "server_tool_use", id: "srvtoolu_123", name: "tool_search_tool_regex" },
        { type: "tool_search_tool_result", tool_use_id: "srvtoolu_123", content: {} },
        { type: "tool_use", id: "toolu_abc", name: "Bash", input: {} },
      ],
    } as any
    const result = filterServerToolBlocksFromResponse(response)
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("text")
    expect(result.content[1].type).toBe("tool_use")
  })

  test("should return same reference when no blocks are filtered", () => {
    const response = {
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "toolu_abc", name: "Bash", input: {} },
      ],
    } as any
    const result = filterServerToolBlocksFromResponse(response)
    expect(result).toBe(response) // same reference, no allocation
  })

  test("should handle response with only server tool blocks", () => {
    const response = {
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_regex" },
        { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: {} },
      ],
    } as any
    const result = filterServerToolBlocksFromResponse(response)
    expect(result.content).toHaveLength(0)
  })

  test("should filter web_search_tool_result", () => {
    const response = {
      content: [
        { type: "text", text: "Based on my search..." },
        { type: "server_tool_use", id: "srvtoolu_ws", name: "web_search" },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws", content: {} },
      ],
    } as any
    const result = filterServerToolBlocksFromResponse(response)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
  })

  test("should NOT filter tool_result (client tool result)", () => {
    const response = {
      content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "output" }],
    } as any
    const result = filterServerToolBlocksFromResponse(response)
    expect(result.content).toHaveLength(1)
    expect(result).toBe(response) // unchanged
  })
})
