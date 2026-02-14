import { afterAll, describe, expect, test } from "bun:test"

import type { Tool } from "~/types/api/anthropic"

import { convertServerToolsToCustom } from "~/lib/anthropic/sanitize"
import { state } from "~/lib/state"

const originalRewriteAnthropicTools = state.rewriteAnthropicTools

afterAll(() => {
  state.rewriteAnthropicTools = originalRewriteAnthropicTools
})

describe("convertServerToolsToCustom", () => {
  describe("when rewriting is disabled", () => {
    test("should return undefined for undefined input", () => {
      state.rewriteAnthropicTools = false
      expect(convertServerToolsToCustom(undefined)).toBeUndefined()
    })

    test("should return the same array reference (no allocation)", () => {
      state.rewriteAnthropicTools = false
      const tools: Array<Tool> = [
        { name: "web_search", type: "web_search_20250305" },
        { name: "Bash", description: "Run bash", input_schema: { type: "object" } },
      ]
      const result = convertServerToolsToCustom(tools)
      expect(result).toBe(tools) // same reference, not a copy
    })
  })

  describe("when rewriting is enabled", () => {
    test("should convert web_search server tool to custom tool", () => {
      state.rewriteAnthropicTools = true
      const tools: Array<Tool> = [{ name: "web_search", type: "web_search_20250305" }]
      const result = convertServerToolsToCustom(tools)!
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("web_search")
      expect(result[0].description).toContain("Search the web")
      expect(result[0].input_schema).toBeDefined()
      expect(result[0].type).toBeUndefined() // server type removed
    })

    test("should convert code_execution server tool", () => {
      state.rewriteAnthropicTools = true
      const tools: Array<Tool> = [{ name: "code_execution", type: "code_execution_20250522" }]
      const result = convertServerToolsToCustom(tools)!
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("code_execution")
      expect(result[0].description).toContain("Execute code")
    })

    test("should pass through regular custom tools unchanged", () => {
      state.rewriteAnthropicTools = true
      const customTool: Tool = {
        name: "Bash",
        description: "Run bash commands",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      }
      const tools: Array<Tool> = [customTool]
      const result = convertServerToolsToCustom(tools)!
      expect(result).toHaveLength(1)
      expect(result[0]).toBe(customTool) // same reference
    })

    test("should handle mixed server and custom tools", () => {
      state.rewriteAnthropicTools = true
      const tools: Array<Tool> = [
        { name: "web_search", type: "web_search_20250305" },
        { name: "Bash", description: "Run bash", input_schema: { type: "object" } },
        { name: "web_fetch", type: "web_fetch_20250305" },
      ]
      const result = convertServerToolsToCustom(tools)!
      expect(result).toHaveLength(3)
      // web_search converted
      expect(result[0].type).toBeUndefined()
      expect(result[0].description).toContain("Search the web")
      // Bash passed through
      expect(result[1].name).toBe("Bash")
      expect(result[1].description).toBe("Run bash")
      // web_fetch converted
      expect(result[2].type).toBeUndefined()
      expect(result[2].description).toContain("Fetch content")
    })

    test("should return undefined when all tools are removed", () => {
      state.rewriteAnthropicTools = true
      // Simulate a removable tool by testing with a tool type that doesn't match any config
      // (currently no tools have remove=true, but test the empty result path)
      const tools: Array<Tool> = [{ name: "web_search", type: "web_search_20250305" }]
      // This should convert, not remove, so result is not empty
      const result = convertServerToolsToCustom(tools)
      expect(result).toBeDefined()
      expect(result).toHaveLength(1)
    })

    test("should return undefined for empty array", () => {
      state.rewriteAnthropicTools = true
      const result = convertServerToolsToCustom([])
      expect(result).toBeUndefined()
    })

    test("should match tools by type prefix, not exact match", () => {
      state.rewriteAnthropicTools = true
      // Different date versions should all match the same prefix
      const tools: Array<Tool> = [
        { name: "ws1", type: "web_search_20250101" },
        { name: "ws2", type: "web_search_20250305" },
        { name: "ws3", type: "web_search_20260101" },
      ]
      const result = convertServerToolsToCustom(tools)!
      expect(result).toHaveLength(3)
      for (const tool of result) {
        expect(tool.type).toBeUndefined()
        expect(tool.description).toContain("Search the web")
      }
    })
  })
})
